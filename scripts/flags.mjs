export function nodeFlags() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const flags = [];
  if (major < 24) flags.push("--experimental-sqlite");
  if (major < 22 || (major === 22 && minor < 18)) flags.push("--experimental-strip-types");
  return flags;
}
