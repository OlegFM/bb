import { realpath as realpathCallback } from "node:fs";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import {
  buildHostPathKey,
  detectHostPathFlavor,
  isBareDriveHostPath,
  isUncOrDeviceHostPath,
  normalizeHostPath,
} from "@bb/domain";
import type {
  CanonicalHostPath,
  HostDaemonOnlineRpcResult,
} from "@bb/host-daemon-contract";
import {
  ExpectedCommandDispatchError,
  type CommandOf,
} from "../command-dispatch-support.js";
import { isFsErrorWithCode } from "../fs-errors.js";

const WINDOWS_EXTENDED_LENGTH_PREFIX = "\\\\?\\";
const realpathNative = promisify(realpathCallback.native);

export interface CanonicalizeHostPathArgs {
  path: string;
  platform: NodeJS.Platform;
  realpath: (path: string) => Promise<string>;
  stat: (path: string) => Promise<{ isDirectory(): boolean }>;
}

function stripExtendedLengthPrefix(path: string): string {
  return path.startsWith(WINDOWS_EXTENDED_LENGTH_PREFIX)
    ? path.slice(WINDOWS_EXTENDED_LENGTH_PREFIX.length)
    : path;
}

function assertAcceptedShape(path: string, platform: NodeJS.Platform): void {
  if (platform === "win32") {
    if (isUncOrDeviceHostPath(path)) {
      throw new ExpectedCommandDispatchError(
        "invalid_path",
        `Path "${path}" is a UNC or device path; only drive-letter paths are supported`,
      );
    }
    if (isBareDriveHostPath(path) || detectHostPathFlavor(path) !== "windows") {
      throw new ExpectedCommandDispatchError(
        "invalid_path",
        `Path "${path}" must be a drive-absolute path such as C:\\Users\\me\\repo`,
      );
    }
    return;
  }
  if (detectHostPathFlavor(path) !== "posix") {
    throw new ExpectedCommandDispatchError(
      "invalid_path",
      `Path "${path}" must be an absolute path`,
    );
  }
}

export async function canonicalizeHostPath(
  args: CanonicalizeHostPathArgs,
): Promise<CanonicalHostPath> {
  assertAcceptedShape(args.path, args.platform);
  let isDirectory: boolean;
  try {
    isDirectory = (await args.stat(args.path)).isDirectory();
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) {
      throw new ExpectedCommandDispatchError(
        "invalid_path",
        `Path "${args.path}" does not exist`,
      );
    }
    if (isFsErrorWithCode(error, "ENOTDIR")) {
      throw new ExpectedCommandDispatchError(
        "invalid_path",
        `Path "${args.path}" is not a directory`,
      );
    }
    throw error;
  }
  if (!isDirectory) {
    throw new ExpectedCommandDispatchError(
      "invalid_path",
      `Path "${args.path}" is not a directory`,
    );
  }
  const resolved = await args.realpath(args.path);
  const candidate =
    args.platform === "win32" ? stripExtendedLengthPrefix(resolved) : resolved;
  if (
    args.platform === "win32" &&
    detectHostPathFlavor(candidate) !== "windows"
  ) {
    throw new ExpectedCommandDispatchError(
      "invalid_path",
      `Path "${args.path}" resolves to "${resolved}", which is not a drive-letter path`,
    );
  }
  const path = normalizeHostPath(candidate);
  return { path, pathKey: buildHostPathKey(path) };
}

export async function canonicalizeHostPathCommand(
  command: CommandOf<"host.canonicalize_path">,
): Promise<HostDaemonOnlineRpcResult<"host.canonicalize_path">> {
  return canonicalizeHostPath({
    path: command.path,
    platform: process.platform,
    realpath: (path) => realpathNative(path),
    stat: (path) => fs.stat(path),
  });
}
