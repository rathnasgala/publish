import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schema from '../contracts/reconciliation-envelope.schema.json' with { type: 'json' };

export const reconciliationAjvOptions = Object.freeze({
  allErrors: true,
  allowUnionTypes: false,
  strict: true,
  unicodeRegExp: true
});

export const reconciliationFormatNames = Object.freeze([]);

export function compileContractSchema(contractSchema) {
  const ajv = new Ajv2020(reconciliationAjvOptions);
  addFormats(ajv, { formats: reconciliationFormatNames });
  return ajv.compile(contractSchema);
}

const validate = compileContractSchema(schema);

export function validateReconciliationEnvelope(payload) {
  if (validate(payload)) return Object.freeze({ valid: true, errorIds: Object.freeze([]) });
  const actionableErrors = validate.errors.filter((error) => error.keyword !== 'if');
  const errorIds = [...new Set(actionableErrors.map((error) =>
    `RECONCILIATION_SCHEMA_${error.keyword.toUpperCase()}`
  ))].sort();
  return Object.freeze({ valid: false, errorIds: Object.freeze(errorIds) });
}
