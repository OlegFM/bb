export {
  deleteSecretFile,
  readOrCreateSecretFile,
  readSecretFile,
  writeSecretFile,
  type SecretFileOptions,
} from "./secret-file.js";
export {
  assertSecretFileAclIsPrivate,
  ensureSecretFileIsPrivate,
  parseSecretFileAcl,
  parseWindowsUserCsv,
  readSecretFileAcl,
  resolveCurrentWindowsUser,
  SECRET_FILE_ACL_REMEDY,
  tightenSecretFileAcl,
  type WindowsAclCommandResult,
  type WindowsAclCommandRunner,
  type WindowsAclDeps,
  type WindowsFileAce,
  type WindowsSecretUser,
} from "./windows-acl.js";
