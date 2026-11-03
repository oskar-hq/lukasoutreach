// Typen für die Tests in server/test (server.mjs selbst ist reines JavaScript ohne Build).
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RunResult { code: number; stdout: string; stderr: string }
export interface RunOptions { cwd?: string; env?: Record<string, string>; timeout?: number; uid?: number; gid?: number }
export type Runner = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;
export interface Version { commit: string; title: string; date: number }
export interface Run { startedAt: number; finishedAt: number | null; ok: boolean | null; message: string; by: string }
export interface Status {
  current: Version;
  latest: Version;
  behind: number;
  changes: Version[];
  checkedAt: number | null;
  running: boolean;
  lastRun: Run | null;
  pendingBuild: boolean;
}
export interface Updater {
  status(options?: { fetch?: boolean }): Promise<Status>;
  update(by: string): Promise<{ status: Status; done: Promise<void> }>;
  readonly running: boolean;
  readonly state: { lastRun: Run | null; checkedAt: number | null; pendingBuild: boolean };
}
export const PORT: number;
export const CHANGES_MAX: number;
export const SERVICES: string[];
export const PRUNE_COMMANDS: string[][];
export const GIT_AUTH_MESSAGE: string;
export function sanitize(text: unknown, max?: number): string;
export function tokenMatches(given: unknown, expected: string): boolean;
export function ensureToken(file: string, owner?: { uid: number; gid: number }): string;
export const execRunner: Runner;
export class UpdaterError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string);
}
export function createUpdater(options: {
  run: Runner;
  repoDir: string;
  stateFile: string;
  selfId: string;
  gitUser?: { uid?: number; gid?: number; home?: string };
  now?: () => number;
  log?: (message: string) => void;
  baseEnv?: Record<string, string | undefined>;
}): Updater;
export function createHandler(updater: Updater, token: string): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
export function main(): Promise<void>;
