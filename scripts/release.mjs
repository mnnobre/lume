// Uso: npm run release -- 0.2.0 "o que mudou"
// Sobe a versão no package.json, commita tudo que mudou, cria a tag e dá push — o GitHub Actions faz o resto.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [version, ...msg] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error('uso: npm run release -- 0.2.0 "o que mudou"');
  process.exit(1);
}
const git = (...args) => execFileSync("git", args, { stdio: "inherit" });

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.version = version;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
execFileSync("npm install --package-lock-only --silent", { stdio: "inherit", shell: true }); // npm é .cmd no Windows

git("add", "-A"); // a release leva tudo que mudou desde a última
git("commit", "-m", `v${version}${msg.length ? `: ${msg.join(" ")}` : ""}`);
git("tag", `v${version}`);
git("push");
git("push", "origin", `v${version}`);
console.log(`\nv${version} enviada. Acompanhe: gh run watch -R mnnobre/lume`);
