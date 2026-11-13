import { z } from 'zod';

/** What Node's file system says of a file or folder it could not read: its code, the path it names, and its message. */
export const FsFailureSchema = z.object({
  code: z.string().optional().catch(undefined),
  path: z.string().optional().catch(undefined),
  message: z.string().catch(''),
}).catch({ message: '' });

export type FsFailure = z.infer<typeof FsFailureSchema>;

/** Whether `failure` says there is nothing there to read. */
export function isMissing({ code }: FsFailure): boolean {
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Why teamai cannot read what `failure` names, to follow "because". */
export function cannotReadBecause({ code, message }: FsFailure): string {
  return code === 'EACCES' || code === 'EPERM' ? 'it has no permission to read it' : `reading it failed (${message || 'teamai does not know why'})`;
}
