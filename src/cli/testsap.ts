import { getAllCompanies } from "../sap/companies.js";
import { getSapClient, SapError } from "../sap/serviceLayer.js";

/**
 * Prueba la conexión al Service Layer para cada empresa configurada.
 *
 * Uso:
 *   npm run test:sap            # prueba todas las empresas
 *   npm run test:sap -- empresa1   # prueba solo una
 *
 * Hace login con la cuenta de servicio y una consulta liviana
 * (BusinessPartners $top=1) para validar credenciales + acceso a la CompanyDB.
 */

async function main() {
  const only = process.argv[2];
  let companies = getAllCompanies();
  if (only) companies = companies.filter((c) => c.alias === only);

  if (companies.length === 0) {
    console.error(only ? `No existe la empresa "${only}".` : "No hay empresas configuradas.");
    process.exit(1);
  }

  console.log(`Probando ${companies.length} empresa(s)…\n`);
  let allOk = true;

  for (const c of companies) {
    process.stdout.write(`• ${c.alias} (${c.label}, DB=${c.companyDB}) … `);
    try {
      const client = getSapClient(c.alias);
      const res = await client.get<{ value: unknown[] }>(
        "BusinessPartners",
        "$top=1&$select=CardCode",
      );
      const n = res?.value?.length ?? 0;
      console.log(`✅ OK (login + consulta correcta, ${n} fila de prueba leída)`);
      await client.logout().catch(() => {});
    } catch (e) {
      allOk = false;
      if (e instanceof SapError) {
        console.log(`❌ FALLÓ — SAP ${e.status}${e.sapCode ? ` [${e.sapCode}]` : ""}: ${e.message}`);
      } else {
        console.log(`❌ FALLÓ — ${(e as Error).message}`);
      }
    }
  }

  console.log("");
  console.log(allOk ? "✅ Todas las empresas respondieron correctamente." : "⚠️ Hubo errores; revise URL, credenciales o acceso a la CompanyDB.");
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
