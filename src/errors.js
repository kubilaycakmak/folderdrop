export class Problem extends Error {
  constructor(status, message, code = 'request_failed') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function check(condition, status, message, code) {
  if (!condition) throw new Problem(status, message, code);
}

export function problem(error) {
  return error instanceof Problem ? error : new Problem(500, 'FolderDrop could not complete the operation.', 'internal_error');
}
