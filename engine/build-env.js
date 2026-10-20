// Shared defaults for agent builds and host checks in every Podium copy, including nested or newly created projects.
// UseSharedCompilation is the Roslyn compiler-server protection; disabling the MSBuild server alone is not a substitute.
// An explicit MSBuild project property can override an environment property, so agent prompts also request
// -p:UseSharedCompilation=false. Host check commands run verbatim with these defaults: a repo that explicitly
// overrides them must put -p:UseSharedCompilation=false in its configured command.
// https://learn.microsoft.com/en-us/visualstudio/msbuild/how-to-use-environment-variables-in-a-build
// https://learn.microsoft.com/en-us/visualstudio/msbuild/msbuild-server
const BUILD_DEFAULTS = {
  UseSharedCompilation: 'false',
  DOTNET_CLI_USE_MSBUILD_SERVER: '0',
  MSBUILDDISABLENODEREUSE: '1',
};

export function copyBuildEnv(env = process.env) {
  // Windows environment names are case-insensitive: no inherited duplicate may compete with the canonical name.
  const names = new Set(Object.keys(BUILD_DEFAULTS).map((name) => name.toLowerCase()));
  const kept = Object.fromEntries(Object.entries(env).filter(([name]) => !names.has(name.toLowerCase())));
  return { ...kept, ...BUILD_DEFAULTS };
}
