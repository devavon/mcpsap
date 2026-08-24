/**
 * Empaqueta el add-in para producción:
 *  1) Toma la URL pública (donde MCPSAP servirá el add-in).
 *  2) Reemplaza las URLs localhost del manifest por esa URL pública.
 *  3) Copia el build (dist/) a ../MCPSAP/public para que el backend lo sirva.
 *
 * Uso:  npm run dist -- https://mcpsap-production-xxxx.up.railway.app
 *   (ejecútalo DESPUÉS de `npm run build`; el script `dist` ya encadena ambos)
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const distDir = resolve(root, "dist");
const publicDir = resolve(root, "..", "MCPSAP", "public");

const raw = process.argv[2] || process.env.ADDIN_URL || "";
const baseUrl = raw.replace(/\/+$/, "");

if (!baseUrl) {
  console.error("❌ Falta la URL pública. Uso: npm run dist -- https://TU-DOMINIO");
  process.exit(1);
}
if (!/^https:\/\//i.test(baseUrl)) {
  console.error("❌ La URL debe ser HTTPS. Office no carga add-ins por HTTP.");
  process.exit(1);
}
if (/railway\.internal/i.test(baseUrl)) {
  console.error("❌ Esa es la URL INTERNA de Railway (no accesible desde Excel).");
  console.error("   Usa la pública: Railway → servicio → Settings → Networking → Generate Domain");
  console.error("   (se ve como https://...up.railway.app)");
  process.exit(1);
}
if (!existsSync(resolve(distDir, "taskpane.html"))) {
  console.error("❌ No existe dist/. Corre primero: npm run build");
  process.exit(1);
}

// 1) Manifest con la URL pública
const manifestPath = resolve(distDir, "manifest.xml");
let manifest = readFileSync(manifestPath, "utf8");
manifest = manifest.replaceAll("https://localhost:3000", baseUrl);
writeFileSync(manifestPath, manifest);
console.log(`✔ Manifest apunta a: ${baseUrl}`);

// 2) Copia el build a MCPSAP/public (lo que el backend sirve estáticamente)
rmSync(publicDir, { recursive: true, force: true });
mkdirSync(publicDir, { recursive: true });
cpSync(distDir, publicDir, { recursive: true });
console.log(`✔ Add-in copiado a: ${publicDir}`);

console.log("\nSiguiente:");
console.log("  1) Despliega MCPSAP (incluye la carpeta public/) en Railway.");
console.log(`  2) Verifica:  ${baseUrl}/taskpane.html  y  ${baseUrl}/health`);
console.log(`  3) Sube a M365 Admin → Apps integradas el manifest:`);
console.log(`     ${manifestPath}`);
