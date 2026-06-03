# MCP SAP Business One

Conector **MCP (Model Context Protocol)** para **SAP Business One** vía **Service Layer (OData/HANA)**, con **control de permisos por rol**, **confirmación obligatoria de toda escritura** y **auditoría completa**.

Permite que Claude (u otro cliente MCP) consulte y opere SAP B1 respetando lo que cada usuario tiene permitido hacer.

---

## Cómo funciona

```
Claude  ──HTTP/SSE──▶  MCP Server (este proyecto)  ──OData/HTTPS──▶  SAP Service Layer (HANA)
                         │
                         ├─ login propio del usuario  → rol
                         ├─ RBAC (config/roles.json)   → qué puede hacer cada rol
                         ├─ confirmación de escrituras → nada se crea/edita sin OK
                         └─ auditoría (audit-logs/)     → quién, qué, cuándo, resultado
```

- **Una sola cuenta de servicio** se conecta a SAP. SAP ve una identidad técnica.
- **Los permisos por usuario los aplica el MCP** (capa RBAC) según el rol del usuario que inició sesión, **antes** de tocar SAP.
- **Toda creación/edición** genera primero una *acción pendiente* con un resumen legible; solo se ejecuta tras `confirm_action`.
- **Todo** (lecturas y escrituras) queda registrado en `audit-logs/audit-YYYY-MM-DD.jsonl`.

---

## Requisitos

- Node.js ≥ 20 (probado con v22).
- Acceso de red al Service Layer de SAP B1 (típicamente `https://servidor:50000/b1s/v1`).
- Una cuenta de usuario de SAP B1 para usar como **cuenta de servicio**.

---

## Instalación

```bash
npm install
cp .env.example .env                          # complete con sus datos de SAP
cp config/companies.example.json config/companies.json   # defina sus empresas
cp config/users.example.json config/users.json
```

Edite `.env`:

| Variable | Descripción |
|---|---|
| `SAP_SL_URL` | URL del Service Layer, ej. `https://sap:50000/b1s/v1` |
| `SAP_COMPANY_DB` | Base de datos de la compañía, ej. `SBO_MIEMPRESA` |
| `SAP_USERNAME` / `SAP_PASSWORD` | Credenciales de la **cuenta de servicio** |
| `SAP_TLS_REJECT_UNAUTHORIZED` | `false` para aceptar certificado autofirmado (interno) |
| `MCP_PORT` / `MCP_PATH` | Puerto y ruta del servidor MCP |

---

## Multiempresa

SAP B1 maneja cada empresa como una **base de datos (CompanyDB)** distinta, y cada login del Service Layer es contra una sola CompanyDB. El conector soporta varias empresas así:

- **`config/companies.json`** define las empresas disponibles (alias → CompanyDB, y opcionalmente una URL de Service Layer distinta por empresa).
- **`config/users.json`** indica a qué empresas tiene acceso cada usuario (campo `companies`): una lista de aliases, o `"*"` / omitir para todas.
- El servidor mantiene **una sesión SAP por empresa** (pool de clientes con la cuenta de servicio).
- Al iniciar sesión:
  - si el usuario tiene **una sola** empresa → se **autoselecciona**;
  - si tiene **varias** → debe elegir con `select_company` (puede ver las suyas con `list_companies`) antes de operar.
- Cada operación y cada acción pendiente quedan ligadas a la empresa seleccionada; la confirmación y la auditoría registran la empresa.

> La cuenta de servicio del `.env` debe existir y tener acceso en **cada** CompanyDB que se configure.

## Usuarios y roles

### Roles — `config/roles.json`
Define qué operaciones (`read`, `create`, `update`) puede hacer cada rol sobre cada entidad.
Entidades v1: `BusinessPartners`, `Quotations`, `Orders`, `Invoices`, `PurchaseOrders`, `PurchaseInvoices`.
Use `"*"` como entidad para conceder todo (rol `admin`).

### Crear usuarios — `config/users.json`
```bash
# npm run useradd -- <usuario> <rol> "Nombre" [empresas]
npm run useradd -- jperez ventas "Juan Pérez" empresa1          # solo empresa1
npm run useradd -- gerente finanzas "Ana Gerente" empresa1,empresa2  # dos empresas
npm run useradd -- admin admin "Administrador" "*"              # todas
# pedirá la contraseña; guarda el hash bcrypt
```
Roles incluidos de ejemplo: `admin`, `ventas`, `compras`, `finanzas`, `consulta`.
Edite `config/roles.json` para ajustarlos a su organización.

> `config/users.json` contiene hashes de contraseñas: está en `.gitignore`, **no lo suba al repo**.

---

## Ejecutar

```bash
npm run build && npm start     # producción
npm run dev                    # desarrollo (recarga en caliente)
```

El servidor expone:
- `POST/GET/DELETE  {MCP_PATH}` (por defecto `/mcp`) — endpoint MCP StreamableHTTP.
- `GET /health` — chequeo de estado.

---

## Conectar Claude

En la configuración de servidores MCP del cliente (HTTP):

```json
{
  "mcpServers": {
    "sap-b1": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

---

## Herramientas disponibles

| Herramienta | Qué hace | Permiso |
|---|---|---|
| `login` / `logout` / `whoami` | Sesión, permisos y empresa del usuario | — |
| `list_companies` / `select_company` | Ver / elegir la empresa activa | — |
| `bp_search` / `bp_get` | Buscar / ver socios de negocio | read |
| `bp_create` / `bp_update` | Crear / editar socio (con confirmación) | create / update |
| `sales_quotation_*` | Cotizaciones de venta (search/get/create/update) | según rol |
| `sales_order_*` | Órdenes de venta | según rol |
| `sales_invoice_*` | Facturas de venta | según rol |
| `purchase_order_*` | Órdenes de compra | según rol |
| `purchase_invoice_*` | Facturas de compra | según rol |
| `confirm_action` | Ejecuta una creación/edición pendiente | — |
| `cancel_action` | Descarta una acción pendiente | — |

### Flujo de una escritura (ejemplo)
1. Usuario: *"Crea una orden de venta para C0001 con 2 unidades del ítem A001"*.
2. `sales_order_create` → devuelve **resumen** + `pendingId` (no se crea nada aún).
3. Claude muestra el resumen y pide confirmación.
4. Usuario aprueba → `confirm_action { pendingId }` → se crea en SAP y se audita.

---

## Despliegue en Railway

El proyecto está listo para Railway (incluye [railway.json](railway.json) con build Nixpacks, `startCommand` y healthcheck en `/health`).

El despliegue usa **Docker** (ver [Dockerfile](Dockerfile)); `railway.json` está configurado con `"builder": "DOCKERFILE"`.

### 1. Subir el código
- **Vía GitHub**: sube el repo y, en Railway, *New Project → Deploy from GitHub* (detecta el Dockerfile).
- **Vía CLI**: `npm i -g @railway/cli && railway init && railway up`.

### Probar la imagen Docker en local (opcional)
```bash
docker build -t mcp-sap-b1 .
docker run --rm -p 3000:3000 \
  -e SAP_SL_URL="https://20.98.202.219:50000/b1s/v1" \
  -e SAP_USERNAME="manager" -e SAP_PASSWORD="••••" \
  -e SAP_TLS_REJECT_UNAUTHORIZED="false" \
  -e MCP_API_KEY="una-clave" -e AUDIT_STDOUT="true" \
  -e USERS_JSON="$(node -e "console.log(JSON.stringify(require('./config/users.json')))")" \
  mcp-sap-b1
# luego: curl http://localhost:3000/health
```

> `config/companies.json` y `config/roles.json` se incluyen en el deploy. `config/users.json` está en `.gitignore` (contiene hashes), así que los usuarios se pasan por la variable `USERS_JSON`.

### 2. Variables de entorno (Railway → Variables)
| Variable | Valor |
|---|---|
| `SAP_SL_URL` | `https://20.98.202.219:50000/b1s/v1` |
| `SAP_USERNAME` | la cuenta de servicio |
| `SAP_PASSWORD` | su clave |
| `SAP_TLS_REJECT_UNAUTHORIZED` | `false` (el Service Layer suele usar certificado autofirmado) |
| `MCP_API_KEY` | una clave larga aleatoria (protege el endpoint) |
| `AUDIT_STDOUT` | `true` (el disco de Railway es efímero; así los logs van a la consola) |
| `USERS_JSON` | el JSON de usuarios en una línea (ver `npm run` abajo) |

No definas `PORT` ni `MCP_PORT`: Railway inyecta `PORT` automáticamente.

Para obtener el valor de `USERS_JSON`:
```bash
node -e "console.log(JSON.stringify(require('./config/users.json')))"
```
(Opcionalmente puedes definir `COMPANIES_JSON` y `ROLES_JSON` igual, si prefieres no subir esos archivos.)

### 3. Conectar Claude al servicio en Railway
Railway te da una URL pública (ej. `https://mcpsap-production.up.railway.app`). El endpoint MCP es esa URL + `MCP_PATH`:
```bash
claude mcp add --transport http sap-b1 https://TU-APP.up.railway.app/mcp \
  --header "x-api-key: TU_MCP_API_KEY"
```

> ⚠️ **Red**: Railway corre en la nube, así que el Service Layer de SAP debe ser **alcanzable desde internet**. Tu URL usa una IP pública (`20.98.202.219`), lo cual funciona; asegúrate de que el firewall del servidor SAP permita el tráfico entrante al puerto `50000` desde Railway (o restringe por IP de salida de Railway).

## Seguridad

- **Sin sesión no se hace nada**: cada herramienta (salvo `login`) exige sesión válida.
- **RBAC**: el rol se valida en cada operación; un permiso denegado se audita y se informa.
- **Confirmación previa siempre** en `create`/`update`.
- **Cuenta de servicio** con sesión gestionada y re-login automático.
- **Auditoría JSONL** lista para ingestar en un SIEM.
- Sesiones del MCP y acciones pendientes **expiran** (configurable en `.env`).

### Recomendaciones de despliegue
- Ponga el servidor detrás de **TLS** (reverse proxy) si lo exponen fuera de la red interna.
- Restrinja por firewall quién llega al puerto del Service Layer y al del MCP.
- Use una cuenta de servicio de SAP con **solo los permisos que el conjunto de roles realmente necesita**.

---

## Estructura

```
src/
├── index.ts                 # servidor HTTP/SSE (StreamableHTTP)
├── server.ts                # crea el McpServer y registra herramientas
├── config.ts                # carga/validación de .env
├── types.ts                 # tipos compartidos
├── sap/
│   ├── serviceLayer.ts      # cliente Service Layer (login, sesión, OData)
│   └── entities.ts          # catálogo de entidades v1
├── auth/
│   ├── store.ts             # carga de users.json / roles.json (caché)
│   ├── roles.ts             # RBAC: checks de permisos
│   └── session.ts           # login y sesiones del MCP
├── audit/logger.ts          # auditoría JSONL
├── pending/store.ts         # acciones pendientes de confirmación
├── tools/                   # herramientas MCP
└── cli/useradd.ts           # alta/edición de usuarios
config/
├── roles.json               # definición de roles
└── users.example.json       # plantilla de usuarios
```

---

## Roadmap (siguientes versiones)

- Inventario/artículos (`Items`), stock por almacén y listas de precios.
- Asientos contables y reportes financieros.
- Ejecución de *queries* guardadas de SAP.
- Endpoint de administración de usuarios/roles.
- Opción de mapear al **usuario real de SAP** (validación de credenciales contra SAP) si se desea reflejar autorizaciones nativas.
```
