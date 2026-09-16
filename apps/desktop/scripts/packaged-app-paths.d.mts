export function resolvePackagedAppBinary(args: {
  executableName: string;
  platform: NodeJS.Platform;
  productName: string;
  releaseDir: string;
}): Promise<string>;
