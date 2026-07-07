import { writeFileSync } from "node:fs";
import { join } from "node:path";

const nextEnvPath = join(process.cwd(), "next-env.d.ts");

writeFileSync(
  nextEnvPath,
  `/// <reference types="next" />
/// <reference types="next/image-types/global" />
import "./.next/dev/types/routes.d.ts";

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
`,
);
