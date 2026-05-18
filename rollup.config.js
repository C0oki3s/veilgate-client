import typescript from "@rollup/plugin-typescript";

const tsPlugin = () =>
  typescript({ tsconfig: "./tsconfig.json", declaration: false, outDir: undefined });

export default [
  {
    input: "src/index.ts",
    output: { file: "dist/client.esm.js", format: "es", sourcemap: true },
    plugins: [tsPlugin()],
  },
  {
    input: "src/index.ts",
    output: { file: "dist/client.cjs.js", format: "cjs", exports: "named", sourcemap: true },
    plugins: [tsPlugin()],
  },
  {
    input: "src/index.ts",
    output: { file: "dist/client.umd.js", format: "umd", name: "VeilGate", sourcemap: true },
    plugins: [tsPlugin()],
  },
];
