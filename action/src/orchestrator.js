import { CONTENT_VALIDATION_VERSION, createReconciliationEnvelope } from './envelope.js';
import { ReconciliationTransportError, sendBuildFailure, sendReconciliation } from './transport.js';
import { ActionOutcome } from './contract.js';
import { evaluateDeployFloor, floorOverrideReason } from './floor-guard.js';

export const ActionOperation = Object.freeze({
  BUILD: 'build',
  ACKNOWLEDGE_DEPLOYMENT: 'acknowledge-deployment',
  REPORT_FAILURE: 'report-failure'
});

export const BuildMode = Object.freeze({
  BUILD_ONLY: 'build-only',
  BUILD_AND_DEPLOY: 'build-and-deploy'
});

function requireSha(value, field) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new TypeError(`${field} must be a lowercase commit SHA`);
  }
}

async function reconcile(
  input,
  manifest,
  adapters,
  floorGuardOverride = null,
  daysSinceLastCommit = input.daysSinceLastCommit ?? 0
) {
  try {
    return await (adapters.sendReconciliation ?? sendReconciliation)({
      apiBaseUrl: input.apiBaseUrl,
      siteId: input.siteId,
      siteSecret: input.siteSecret,
      fetchImpl: adapters.fetch,
      envelopeForAttempt: () => createReconciliationEnvelope({
        manifest,
        commitSha: input.deployedCommitSha ?? input.commitSha,
        runId: input.runId,
        runAttempt: input.runAttempt,
        emittedAt: adapters.now().toISOString(),
        runStatus: 'SUCCESS',
        daysSinceLastCommit,
        deploymentCommitSha: input.deploymentCommitSha,
        floorGuardOverride
      })
    });
  } catch (error) {
    if (error instanceof ReconciliationTransportError
        && error.status === 409
        && error.code === 'STALE_RUN_IDENTITY') {
      return { stale: true };
    }
    throw error;
  }
}

export async function runAction(input, adapters) {
  const operation = input.operation ?? ActionOperation.BUILD;
  requireSha(input.commitSha, 'commitSha');
  const report = {
    operation,
    outcome: ActionOutcome.FAILED,
    reconciliation: null,
    themeAdvisory: null,
    publishedCount: 0,
    republishedCount: 0,
    delistedCount: 0,
    skippedCount: 0,
    skipped: [],
    daysSinceLastCommit: 0,
    keepaliveCommitted: false,
    floorGuardOverridden: false,
    floorGuardOverrideReason: null,
    floorGuardLostPages: 0
  };
  let engagementSnapshotHash = null;
  if (operation === ActionOperation.REPORT_FAILURE) {
    try {
      await (adapters.sendBuildFailure ?? sendBuildFailure)({
        apiBaseUrl: input.apiBaseUrl,
        siteId: input.siteId,
        siteSecret: input.siteSecret,
        fetchImpl: adapters.fetch,
        report: {
          emittedAt: adapters.now().toISOString(),
          runId: input.runId,
          runAttempt: input.runAttempt,
          commitSha: input.commitSha,
          validatorVersion: CONTENT_VALIDATION_VERSION,
          errors: [{
            source: 'workflow',
            code: input.failureCode,
            message: input.failureMessage
          }]
        }
      });
      return report;
    } finally {
      await adapters.report(report);
    }
  }
  try {
    const head = await adapters.currentCommitSha(input.root);
    if (head !== input.commitSha) {
      throw new Error(`Checkout HEAD ${head} does not match expected commit ${input.commitSha}`);
    }
    if (operation === ActionOperation.ACKNOWLEDGE_DEPLOYMENT) {
      await adapters.verifyRecordedState(input);
    }
    if (operation === ActionOperation.BUILD
        || operation === ActionOperation.ACKNOWLEDGE_DEPLOYMENT) {
      if (adapters.refreshBuildSettings == null) {
        throw new Error('Authoritative build settings reader is unavailable');
      }
      await adapters.refreshBuildSettings(input);
    }
    if (operation === ActionOperation.BUILD && adapters.refreshEngagementSnapshot != null) {
      try {
        engagementSnapshotHash = await adapters.refreshEngagementSnapshot(input);
      } catch (error) {
        adapters.warn('ENGAGEMENT_SNAPSHOT_REFRESH_DEFERRED', error);
      }
    }
    let validation = await adapters.validateAndBuild(input);
    let manifest = validation.manifest ?? validation;
    report.skippedCount = validation.skippedCount ?? 0;
    report.skipped = validation.skipped ?? [];
    if (operation === ActionOperation.ACKNOWLEDGE_DEPLOYMENT) {
      report.reconciliation = await reconcile(
        input,
        manifest,
        adapters,
        validation.floorGuardOverride ?? null
      );
      report.themeAdvisory = report.reconciliation?.themeAdvisory ?? null;
      Object.assign(report, reconciliationCounts(report.reconciliation));
      const floorGuardOverridden = validation.floorGuardOverride != null;
      if (floorGuardOverridden) {
        report.floorGuardOverridden = true;
        report.floorGuardOverrideReason = validation.floorGuardOverride.reason;
        report.floorGuardLostPages = validation.floorGuardOverride.lostPages;
      }
      report.outcome = reconciliationOutcome(
        report.reconciliation,
        report.skippedCount,
        floorGuardOverridden
      );
      return report;
    }
    if (operation !== ActionOperation.BUILD) throw new TypeError(`Unsupported operation: ${operation}`);
    if (!Object.values(BuildMode).includes(input.mode)) throw new TypeError(`Unsupported mode: ${input.mode}`);
    let contentIdentityChanges = manifest.assignedContentIds ?? [];
    if (input.mode === BuildMode.BUILD_AND_DEPLOY) {
      if (adapters.resolveArticleIdentities == null
          || adapters.applyArticleIdentityRepairs == null) {
        throw new Error('Article identity repair is unavailable');
      }
      const resolution = await adapters.resolveArticleIdentities(input, manifest);
      if (resolution.repairs.length > 0) {
        contentIdentityChanges = await adapters.applyArticleIdentityRepairs(
          input,
          manifest,
          resolution
        );
        validation = await adapters.validateAndBuild(input);
        manifest = validation.manifest ?? validation;
        const verification = await adapters.resolveArticleIdentities(input, manifest);
        if (verification.repairs.length > 0) {
          throw new Error('Article identity repair did not converge after rebuilding the publication');
        }
      }
    }
    report.skippedCount = validation.skippedCount ?? 0;
    report.skipped = validation.skipped ?? [];
    const keepalive = await adapters.keepalive(input);
    report.daysSinceLastCommit = keepalive?.daysSinceLastCommit ?? input.daysSinceLastCommit ?? 0;
    report.keepaliveCommitted = keepalive?.committed === true;
    if (input.mode === BuildMode.BUILD_ONLY) {
      report.outcome = ActionOutcome.PARTIAL;
      return report;
    }
    const commitMessage = await adapters.commitMessage(input.commitSha, input.root);
    const overrideReason = floorOverrideReason(commitMessage);
    if ((overrideReason == null) !== (input.floorGuardOverrideCommitSha == null)) {
      throw new Error(
        'Floor override requires both the Gala-Floor-Override commit trailer and matching SHA confirmation'
      );
    }
    const floor = evaluateDeployFloor({
      previousPageCount: await adapters.previousPageCount(input),
      currentPageCount: await adapters.currentPageCount(input, manifest),
      percent: input.floorGuardPercent,
      pages: input.floorGuardPages,
      overrideReason,
      skipped: validation.skipped ?? []
    });
    report.floorGuardOverridden = floor.overridden;
    report.floorGuardOverrideReason = floor.reason ?? null;
    report.floorGuardLostPages = floor.lostPages;
    const floorGuardOverride = floor.overridden ? {
      previousPageCount: floor.previousPageCount,
      currentPageCount: floor.currentPageCount,
      lostPages: floor.lostPages,
      reason: floor.reason
    } : null;
    await adapters.stageDeployment(
      input,
      manifest,
      floorGuardOverride,
      engagementSnapshotHash,
      contentIdentityChanges
    );
    report.outcome = ActionOutcome.PARTIAL;
    return report;
  } catch (error) {
    try {
      await (adapters.sendBuildFailure ?? sendBuildFailure)({
        apiBaseUrl: input.apiBaseUrl,
        siteId: input.siteId,
        siteSecret: input.siteSecret,
        fetchImpl: adapters.fetch,
        report: {
          emittedAt: adapters.now().toISOString(),
          runId: input.runId,
          runAttempt: input.runAttempt,
          commitSha: input.deployedCommitSha ?? input.commitSha,
          validatorVersion: CONTENT_VALIDATION_VERSION,
          errors: [{
            source: 'action',
            code: 'BUILD_FAILED',
            message: String(error instanceof Error ? error.message : error).slice(0, 1024)
          }]
        }
      });
    } catch (reportError) {
      adapters.warn('BUILD_FAILURE_REPORT_DEFERRED', reportError);
    }
    throw error;
  } finally {
    await adapters.report(report);
  }
}

function reconciliationCounts(result) {
  return {
    publishedCount: result?.published ?? 0,
    republishedCount: result?.republished ?? 0,
    delistedCount: result?.delisted ?? 0
  };
}

function reconciliationOutcome(result, skippedCount, floorGuardOverridden = false) {
  if (result?.stale === true) return ActionOutcome.SKIPPED_STALE;
  if (result == null || skippedCount > 0 || floorGuardOverridden) return ActionOutcome.PARTIAL;
  if (result.noOp === true) return ActionOutcome.NO_OP;
  return ActionOutcome.SUCCESS;
}
