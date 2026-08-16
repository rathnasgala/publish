import { CONTENT_VALIDATION_VERSION, createReconciliationEnvelope } from './envelope.js';
import { ReconciliationTransportError, sendBuildFailure, sendReconciliation } from './transport.js';
import { ActionOutcome } from './contract.js';
import { evaluateDeployFloor, floorOverrideReason } from './floor-guard.js';

export const ActionOperation = Object.freeze({
  BUILD: 'build',
  ACKNOWLEDGE_DEPLOYMENT: 'acknowledge-deployment'
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
        floorGuardOverride
      })
    });
  } catch (error) {
    // Only a transport failure is worth deferring: the deployment is already live and the API
    // can be told about it on a later run. Every other error is a defect in this action or a
    // break in the envelope contract, and deferring those hid a total contract break behind a
    // green build for every publication until someone opened the site and found a 404.
    if (!(error instanceof ReconciliationTransportError)) throw error;
    if (error.status === 409) return { stale: true };
    adapters.warn(error.status === 413
      ? 'RECONCILIATION_PAYLOAD_LIMIT_APPROACHING_OR_EXCEEDED'
      : 'RECONCILIATION_DEFERRED', error);
    return null;
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
  try {
    const head = await adapters.currentCommitSha(input.root);
    if (head !== input.commitSha) {
      throw new Error(`Checkout HEAD ${head} does not match expected commit ${input.commitSha}`);
    }
    if (operation === ActionOperation.ACKNOWLEDGE_DEPLOYMENT) {
      await adapters.verifyRecordedState(input);
    }
    if (operation === ActionOperation.BUILD && adapters.refreshEngagementSnapshot != null) {
      try {
        engagementSnapshotHash = await adapters.refreshEngagementSnapshot(input);
      } catch (error) {
        adapters.warn('ENGAGEMENT_SNAPSHOT_REFRESH_DEFERRED', error);
      }
    }
    const validation = await adapters.validateAndBuild(input);
    const manifest = validation.manifest ?? validation;
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
      input, manifest, floorGuardOverride, engagementSnapshotHash
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
