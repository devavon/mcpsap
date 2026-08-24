# Add-in de Excel para SAP Business One

Complemento de **Excel (Office.js)** que trae información de **SAP Business One**
a una hoja de cálculo (solo lectura), reutilizando el conector
[MCPSAP](../MCPSAP/): mismo login, control de permisos por rol (RBAC),
multiempresa y auditoría.

```
Excel (taskpane Office.js)  ──HTTPS/JSON──▶  API REST /api en MCPSAP  ──OData──▶  SAP Service Layer (HANA)
                                              reusa: ServiceLayerClient · ENTITIES · RBAC · auth · auditoría
```

Funciona en Excel para **Windows, Mac y Web**. No expone ninguna escritura a SAP.

---

## 1. Backend (MCPSAP)

La API REST se añadió al proyecto `../MCPSAP` (ruta `/api`, aditiva, no toca el MCP).
Endpoints (todos JSON; auth por `Authorization: Bearer <token>` salvo `/login`):

| Método | Ruta                  | Descripción                                   |
|--------|-----------------------|-----------------------------------------------|
| POST   | `/api/login`          | `{username,password}` → `{token, perfil}`     |
| GET    | `/api/me`             | Perfil de la sesión actual                    |
| GET    | `/api/companies`      | Empresas permitidas al usuario                |
| POST   | `/api/select-company` | `{alias}` → fija la empresa activa            |
| GET    | `/api/entities`       | Entidades que el rol puede **leer**           |
| POST   | `/api/query`          | Consulta (filtros) → filas para Excel         |
| POST   | `/api/logout`         | Cierra la sesión                              |

### Correr el backend con HTTPS (necesario para el add-in)

El taskpane se sirve por HTTPS; el navegador/WebView bloquea llamadas a `http://`.
Use los certificados de desarrollo de Office (ya confiables en el sistema):

```bash
# 1) Generar/instalar certificados de dev (una sola vez)
cd ../ExtensionSAPExcel
npx office-addin-dev-certs install
#   crea ~/.office-addin-dev-certs/localhost.key y localhost.crt

# 2) En MCPSAP/.env añadir (ajuste USUARIO):
#    HTTPS_KEY=/Users/USUARIO/.office-addin-dev-certs/localhost.key
#    HTTPS_CERT=/Users/USUARIO/.office-addin-dev-certs/localhost.crt
#    (en producción / Railway no hace falta: la plataforma da el TLS)

# 3) Arrancar
cd ../MCPSAP
npm install && npm run build && npm start
#   → API REST (Excel) en https://0.0.0.0:3000/api
```

> El backend y el add-in usan puertos distintos: backend en `3000`, el dev-server
> del add-in en otro puerto si hay choque (Office abre el taskpane desde su propio
> bundle). Si corre ambos en local con el mismo `3000`, cambie `PORT` del backend
> (p.ej. `PORT=4000`) y ponga esa URL en el campo **Servidor (API)** del panel.

---

## 2. Add-in (este proyecto)

```bash
npm install
npm start          # compila, levanta el dev-server HTTPS y hace sideload en Excel
```

`npm start` abre Excel y carga el complemento (pestaña **Inicio → SAP B1 →
Consultar SAP**). Para detenerlo: `npm stop`.

Comandos útiles:

| Comando            | Qué hace                                         |
|--------------------|--------------------------------------------------|
| `npm start`        | Sideload + dev-server (desarrollo)               |
| `npm stop`         | Detiene el sideload                              |
| `npm run dev-server` | Solo el dev-server HTTPS                        |
| `npm run build`    | Bundle de producción en `dist/`                  |
| `npm run validate` | Valida `manifest.xml`                            |

### Sideload manual (alternativa)

- **Mac**: copie `manifest.xml` a
  `~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/` y reinicie Excel.
- **Windows**: comparta una carpeta de red con `manifest.xml` y agréguela en
  *Archivo → Opciones → Centro de confianza → Catálogos de complementos*.
- **Web**: *Insertar → Complementos → Cargar mi complemento → manifest.xml*.

---

## 3. Uso

1. En el panel, confirme **Servidor (API)** (por defecto `https://localhost:3000/api`).
2. Inicie sesión con un usuario de SAP creado en MCPSAP
   (`npm run useradd` en ese proyecto).
3. Elija **empresa** (si tiene varias) y los **datos a traer** (entidad).
4. Aplique filtros (texto, rango de fechas, socio, máx. filas, o filtro OData
   avanzado) y pulse **Traer a Excel**.
5. Los resultados se vuelcan como **tabla con filtros** en la hoja activa
   (o en una hoja nueva si marca la casilla).

Solo aparecen las entidades que el **rol** del usuario puede leer; cada consulta
queda registrada en la **auditoría** de MCPSAP.

---

## Informes financieros (contabilidad)

Además de las entidades, el panel ofrece informes para contadores. Aparecen
agrupados como **"Informes financieros"** en el selector y requieren permiso de
lectura sobre `Financials` (lo tienen los roles `finanzas` y `consulta`).

| Informe | Cómo se obtiene | Filtros |
|---|---|---|
| **Plan de cuentas** | Lectura directa de `ChartOfAccounts` | buscar |
| **Mayor / Libro mayor por cuenta** | Asientos (`JournalEntries` + líneas) con saldo acumulado | cuenta, desde, hasta |
| **Balance de comprobación** | Calculado: agrega débitos/créditos por cuenta del periodo | desde*, hasta* |
| **Saldos y antigüedad de socios** | Facturas abiertas por socio en tramos 1-30/31-60/61-90/90+ | tipo de socio, a la fecha |

\* obligatorio. Los informes calculados leen todos los asientos/facturas del
rango (paginación automática), así que acotar fechas mantiene la consulta ágil.

> Los informes siguen los esquemas estándar del Service Layer; conviene
> validarlos contra la instalación real cuando la cuenta de servicio SAP conecte.

## Más datos en cualquier consulta

Para las entidades, el panel trae por defecto **todas las filas** (paginación
automática) y **todas las columnas**. Puedes limitar filas (100/500/1000) o
desmarcar "Todas las columnas" para consultas más rápidas. En **Opciones
avanzadas** puedes añadir un `$filter` OData y un orden personalizado.

## Producción

- Despliegue MCPSAP (ya soporta Railway) y fije `REST_CORS_ORIGIN` al origen donde
  publique el add-in (p.ej. GitHub Pages / un storage estático con HTTPS).
- `npm run build` genera `dist/`; suba ese contenido y un `manifest.xml` cuyas URLs
  apunten al dominio de publicación (en vez de `https://localhost:3000`).
- Distribuya el manifest por *Integrated Apps* del centro de administración de
  Microsoft 365 para implementarlo a los usuarios de la organización.
