export function parseTarGzMembers(buffer: Buffer): string[];

export const RELEASE_ALLOWED_FILES: Set<string>;
export const RELEASE_ALLOWED_PREFIXES: string[];
export const RELEASE_FORBIDDEN: RegExp[];
