export interface RealDbProbe {
  journal: string;
  integrityOk: boolean;
}

export interface DoctorStorageProbeResult {
  /** True when the storageDir is a UNC/network path (refused). */
  unc: boolean;
  /** Temp-dir writability (feeds the "temp SQLite capability" check). */
  writable: boolean;
  writableError?: string;
  /** Real storage dir is writable (checked with access W_OK, no write). */
  realStorageWritable: boolean;
  realStorageWritableError?: string;
  realExists: boolean;
  real?: RealDbProbe;
  realError?: string;
  version?: string;
  journal?: string;
  integrityOk: boolean;
  journalOk: boolean;
  error?: string;
}

export function probeStorage(args: {
  storageDir: string;
  probeDir: string;
  /** Injectable real-storage access check (default fs access). */
  accessReal?: (path: string, mode: number) => Promise<void>;
}): Promise<DoctorStorageProbeResult>;

export interface LegacyProbeResult {
  path: string;
  present: boolean;
  deleted: boolean;
  content?: string;
}

/** Delete only OUR OWN stale probe (exact "ok" content); preserve anything else. */
export function legacyProbeCleanup(args: { storageDir: string }): Promise<LegacyProbeResult>;
