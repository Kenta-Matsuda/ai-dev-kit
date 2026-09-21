'use strict';
/**
 * Process exit codes. These are a public contract: CI pipelines and branch
 * policies branch on them, so the numbers must not be reassigned.
 *
 *   0  success
 *   1  general error
 *   2  drift: materialised tool config disagrees with .aidev/materialized.json
 *   3  permission policy violation
 *   4  wiki inconsistency: the Wiki is missing or structurally broken
 */
const EXIT = {
  OK: 0,
  GENERAL: 1,
  DRIFT: 2,
  PERMISSION: 3,
  KNOWLEDGE: 4,
};

/** An error carrying a specific exit code. */
class AidevError extends Error {
  constructor(message, code = EXIT.GENERAL, detail) {
    super(message);
    this.name = 'AidevError';
    this.code = code;
    this.detail = detail;
  }
}

class DriftError extends AidevError {
  constructor(message, detail) { super(message, EXIT.DRIFT, detail); this.name = 'DriftError'; }
}
class PermissionError extends AidevError {
  constructor(message, detail) { super(message, EXIT.PERMISSION, detail); this.name = 'PermissionError'; }
}
class KnowledgeError extends AidevError {
  constructor(message, detail) { super(message, EXIT.KNOWLEDGE, detail); this.name = 'KnowledgeError'; }
}

module.exports = { EXIT, AidevError, DriftError, PermissionError, KnowledgeError };
