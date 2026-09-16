export function resolvePackagedAppBinary(args: {
  executableName: string;
  platform: NodeJS.Platform | string;
  productName: string;
  releaseDir: string;
}): Promise<string>;
