import { tmpdir } from "node:os";
import { join } from "node:path";

export function tmpRoot(name: string): string {
  return join(tmpdir(), name);
}
