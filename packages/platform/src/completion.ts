/** Text was cut off, rather than a request or tool failing for another reason. */
export const isCutOffFinish = (reason?: string): boolean => ['length', 'max_tokens', 'missing', 'broken-stream'].includes(reason ?? '');
