export class PodiumError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PodiumError';
    this.code = code;
    this.details = details;
  }
}

// A sprint's steps belong to the sprint: it checkpoints, reviews and ships them,
// so Keep, Throw away, Open PR and follow-ups from outside it are refused.
export function sprintJobError() {
  return new PodiumError('sprint-job', 'This is part of a sprint. Use the sprint tool to pause, retry or reassign it.');
}
