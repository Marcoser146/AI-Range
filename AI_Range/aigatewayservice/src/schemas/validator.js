const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const {
  recommendationOutputSchema,
  recommendationRequestSchema,
} = require("./recommendation");
const {
  assessmentOutputSchema,
  assessmentRequestSchema,
} = require("./assessment");
const { reportRequestSchema } = require("./report");

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

for (const schema of [
  recommendationOutputSchema,
  recommendationRequestSchema,
  assessmentOutputSchema,
  assessmentRequestSchema,
  reportRequestSchema,
]) {
  ajv.addSchema(schema, schema.$id);
}

function validate(schemaId, data) {
  const validateFn = ajv.getSchema(schemaId);
  if (!validateFn) throw new Error(`Unknown schema: ${schemaId}`);
  const valid = validateFn(data);
  return {
    valid,
    errors: valid
      ? []
      : validateFn.errors.map((e) => `${e.instancePath || "(root)"} ${e.message}`),
  };
}

module.exports = { validate };
