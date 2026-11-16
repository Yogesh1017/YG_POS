import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // This app is client-rendered and loads data from the local core inside effects
      // (the data lives in the desktop core), so the "no setState in an effect" rule does not fit.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  { files: ["tests/**"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "archive/**",
    "dist-desktop/**",
    "release/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
