import "dotenv/config";

const GRIST_API_URL = (process.env.GRIST_API_URL || "https://docs.getgrist.com/api").replace(/\/+$/, "");
const GRIST_API_KEY = process.env.GRIST_API_KEY;

if (!GRIST_API_KEY) {
  console.warn(
    "[grist-client] ATTENTION: GRIST_API_KEY n'est pas défini. Les appels à l'API Grist échoueront."
  );
}

/**
 * Appel générique à l'API REST de Grist.
 * @param {string} path - chemin relatif, ex: "/docs/abc123/tables"
 * @param {object} options - options fetch (method, body, ...)
 */
async function gristFetch(path, options = {}) {
  const url = `${GRIST_API_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GRIST_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const message =
      (body && (body.error || body.message)) || text || `HTTP ${res.status}`;
    const err = new Error(`Erreur API Grist (${res.status}) sur ${path}: ${message}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return body;
}

/**
 * Convertit une définition de colonne au format exposé par nos outils MCP
 * ({ id, fields: { label, type, formula, isFormula } }) vers l'objet
 * "colinfo" attendu par les actions internes Grist (AddColumn/ModifyColumn),
 * en omettant les propriétés non fournies.
 */
function toColInfo(col) {
  const info = { id: col.id };
  const f = col.fields || {};
  if (f.type !== undefined) info.type = f.type;
  if (f.label !== undefined) info.label = f.label;
  if (f.isFormula !== undefined) info.isFormula = f.isFormula;
  if (f.formula !== undefined) info.formula = f.formula;
  return info;
}

export const grist = {
  // --- Découverte ---
  listOrgs: () => gristFetch("/orgs"),
  listWorkspaces: (orgId) => gristFetch(`/orgs/${orgId}/workspaces`),
  listTables: (docId) => gristFetch(`/docs/${docId}/tables`),
  listColumns: (docId, tableId) => gristFetch(`/docs/${docId}/tables/${tableId}/columns`),

  // --- Lecture de données ---
  getRecords: (docId, tableId, { filter, limit, sort } = {}) => {
    const params = new URLSearchParams();
    if (filter) params.set("filter", JSON.stringify(filter));
    if (limit) params.set("limit", String(limit));
    if (sort) params.set("sort", sort);
    const qs = params.toString();
    return gristFetch(
      `/docs/${docId}/tables/${tableId}/records${qs ? `?${qs}` : ""}`
    );
  },

  // --- Écriture de données ---
  addRecords: (docId, tableId, records) =>
    gristFetch(`/docs/${docId}/tables/${tableId}/records`, {
      method: "POST",
      body: JSON.stringify({ records: records.map((fields) => ({ fields })) }),
    }),

  updateRecords: (docId, tableId, updates) =>
    gristFetch(`/docs/${docId}/tables/${tableId}/records`, {
      method: "PATCH",
      body: JSON.stringify({
        records: updates.map(({ id, fields }) => ({ id, fields })),
      }),
    }),

  // Suppression via l'endpoint bas niveau /apply (actions internes Grist),
  // plus fiable que de deviner un endpoint DELETE non documenté de façon stable.
  deleteRecords: (docId, tableId, rowIds) =>
    grist.applyActions(docId, [["BulkRemoveRecord", tableId, rowIds]]),

  // Ajoute ou met à jour selon des critères-clé, via SQL pour la recherche
  // puis addRecords/updateRecords.
  upsertRecords: async (docId, tableId, records) => {
    const results = [];
    for (const { require, fields } of records) {
      const filter = Object.fromEntries(
        Object.entries(require).map(([k, v]) => [k, [v]])
      );
      const existing = await grist.getRecords(docId, tableId, { filter, limit: 1 });
      const match = existing?.records?.[0];
      if (match) {
        await grist.updateRecords(docId, tableId, [{ id: match.id, fields }]);
        results.push({ id: match.id, action: "update" });
      } else {
        const created = await grist.addRecords(docId, tableId, [{ ...require, ...fields }]);
        results.push({ id: created?.records?.[0]?.id, action: "add" });
      }
    }
    return { records: results };
  },

  // ── Actions bas niveau (format interne Grist) ──────────────────────────
  // Applique une séquence d'actions internes Grist en une seule transaction
  // via l'endpoint /apply. C'est le point de passage commun pour toutes les
  // mutations de structure (tables/colonnes) ci-dessous.
  applyActions: (docId, actions, noparse = false) =>
    gristFetch(`/docs/${docId}/apply${noparse ? "?noparse=1" : ""}`, {
      method: "POST",
      body: JSON.stringify(actions),
    }),

  // ── Schéma — Tables ─────────────────────────────────────────────────────
  createTables: (docId, tables) => {
    const actions = tables.map((t) => [
      "AddTable",
      t.id,
      (t.columns || []).map(toColInfo),
    ]);
    return grist.applyActions(docId, actions);
  },

  deleteTable: (docId, tableId) =>
    grist.applyActions(docId, [["RemoveTable", tableId]]),

  // Modifie les métadonnées d'une table. Le renommage du tableId technique
  // passe par l'action dédiée RenameTable ; les autres métadonnées (ex:
  // onDemand) sont appliquées via UpdateRecord sur la table interne
  // _grist_Tables, en retrouvant son rowId par une requête SQL sur tableId.
  updateTables: async (docId, tables) => {
    const actions = [];
    for (const { id, fields } of tables) {
      const { tableId: newTableId, ...rest } = fields || {};
      const renamed = newTableId && newTableId !== id;
      if (renamed) {
        actions.push(["RenameTable", id, newTableId]);
      }
      if (Object.keys(rest).length > 0) {
        const targetId = renamed ? newTableId : id;
        const result = await grist.runSql(
          docId,
          "SELECT id FROM _grist_Tables WHERE tableId = ?",
          [targetId]
        );
        const row = result?.records?.[0];
        const rowId = row?.fields?.id ?? row?.id;
        if (rowId == null) {
          throw new Error(`Table introuvable en métadonnées: ${targetId}`);
        }
        actions.push(["UpdateRecord", "_grist_Tables", rowId, rest]);
      }
    }
    return grist.applyActions(docId, actions);
  },

  // ── Schéma — Colonnes ───────────────────────────────────────────────────
  addColumns: (docId, tableId, columns) => {
    const actions = columns.map((col) => {
      const { id, ...info } = toColInfo(col);
      return ["AddColumn", tableId, id, info];
    });
    return grist.applyActions(docId, actions);
  },

  updateColumns: (docId, tableId, columns) => {
    const actions = columns.map((col) => {
      const { id, ...info } = toColInfo(col);
      return ["ModifyColumn", tableId, id, info];
    });
    return grist.applyActions(docId, actions);
  },

  // Ajoute une colonne si elle n'existe pas encore, sinon la modifie.
  upsertColumns: async (docId, tableId, columns) => {
    const existing = await grist.listColumns(docId, tableId);
    const existingIds = new Set((existing?.columns || existing || []).map((c) => c.id));
    const actions = columns.map((col) => {
      const { id, ...info } = toColInfo(col);
      return existingIds.has(id)
        ? ["ModifyColumn", tableId, id, info]
        : ["AddColumn", tableId, id, info];
    });
    return grist.applyActions(docId, actions);
  },

  deleteColumn: (docId, tableId, colId) =>
    grist.applyActions(docId, [["RemoveColumn", tableId, colId]]),

  // --- Requête SQL en lecture seule (utile pour des agrégations/analyses) ---
  runSql: (docId, sql, args = []) =>
    gristFetch(`/docs/${docId}/sql`, {
      method: "POST",
      body: JSON.stringify({ sql, args }),
    }),

  // --- Pièces jointes : upload (multipart/form-data) ---
  addAttachments: async (docId, files) => {
    // files: tableau de { filename: string, content: Buffer|Blob, contentType?: string }
    const form = new FormData();
    for (const f of files) {
      const blob = f.content instanceof Blob
        ? f.content
        : new Blob([f.content], { type: f.contentType || "application/octet-stream" });
      form.append("upload", blob, f.filename);
    }

    const url = `${GRIST_API_URL}/docs/${docId}/attachments`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GRIST_API_KEY}`,
        // Ne PAS fixer Content-Type manuellement : fetch génère le bon
        // boundary multipart/form-data automatiquement à partir du FormData.
      },
      body: form,
    });

    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    if (!res.ok) {
      const message = (body && (body.error || body.message)) || text || `HTTP ${res.status}`;
      const err = new Error(`Erreur API Grist (${res.status}) sur /docs/${docId}/attachments: ${message}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }

    return body; // Retourne un tableau des IDs des pièces jointes créées, ex: [12, 13]
  },

};

function downloadUrl(path, params = {}) {
  const url = new URL(`${GRIST_API_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export { GRIST_API_URL, downloadUrl };