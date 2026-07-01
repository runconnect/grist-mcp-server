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
    gristFetch(`/docs/${docId}/apply`, {
      method: "POST",
      body: JSON.stringify([["BulkRemoveRecord", tableId, rowIds]]),
    }),

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

export { GRIST_API_URL };
