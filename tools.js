/**
 * tools.js — Enregistrement exhaustif de tous les outils MCP Grist (~50 outils).
 *
 * Catégories couvertes :
 *  1. Navigation & découverte
 *  2. Lecture de données (records + SQL)
 *  3. Écriture de données (add / update / upsert / delete)
 *  4. Schéma — Tables
 *  5. Schéma — Colonnes
 *  6. Documents — Cycle de vie
 *  7. Workspaces
 *  8. Contrôle d'accès
 *  9. Exports & téléchargements
 * 10. Snapshots & historique
 * 11. Webhooks
 * 12. Pièces jointes
 * 13. Actions bas-niveau (format interne Grist)
 * 14. Admin & performance
 * 15. Organisation & profil
 * 16. Upload de pièces jointes
 */

import { z } from "zod";
import { grist, downloadUrl } from "./gristClient.js";

// ── Schémas Zod réutilisables ─────────────────────────────────────────────────

const zDocId = z.string().describe("Identifiant (docId) du document Grist, ex: '9PJhBDZPyCNoayZxaCwFfS'");
const zTableId = z.string().describe("Identifiant de la table (tel que retourné par list_tables), ex: 'Depenses'");
const zOrgId = z.union([z.string(), z.number()])
  .describe("Identifiant de l'organisation : entier numérique OU sous-domaine, OU 'current'");
const zWsId = z.number().int().describe("Identifiant entier du workspace");
const zRole = z.enum(["owners", "editors", "viewers"]).nullable()
  .describe("Rôle. null = retirer l'accès.");

const zColumnDef = z.object({
  id: z.string().describe("colId technique, ex: 'Montant'"),
  fields: z.object({
    label: z.string().optional().describe("Libellé affiché"),
    type: z.string().optional()
      .describe("'Text'|'Numeric'|'Int'|'Bool'|'Date'|'DateTime'|'Choice'|'ChoiceList'|'Reference'|'ReferenceList'|'Attachments'"),
    formula: z.string().optional().describe("Formule Python (pour colonnes calculées)"),
    isFormula: z.boolean().optional().describe("true = colonne calculée (pas de saisie manuelle)"),
  }).describe("Propriétés de la colonne"),
}).describe("Définition d'une colonne");

// ── Enregistrement ─────────────────────────────────────────────────────────────

export function registerGristTools(server) {

  // ════════════════════════════════════════════════════════════════════════════
  // 1. NAVIGATION & DÉCOUVERTE
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "list_orgs",
    "Liste tous les sites Grist (organisations) accessibles avec la clé API. " +
    "Retourne les id et noms. Premier appel utile pour obtenir un orgId " +
    "avant d'en lister les workspaces.",
    {},
    async () => {
      const d = await grist.listOrgs();
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "list_workspaces",
    "Liste les workspaces et documents d'une organisation Grist. " +
    "Retourne pour chaque workspace son nom, son id et la liste de ses documents " +
    "(avec docId et nom). Permet de naviguer dans l'arborescence ou de trouver un document.",
    { orgId: zOrgId.default("current") },
    async ({ orgId }) => {
      const d = await grist.listWorkspaces(orgId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "find_document",
    "Recherche un document Grist par son nom (ou fragment de nom) parmi tous les " +
    "workspaces de tous les sites accessibles. Retourne les docId, noms et emplacements. " +
    "À utiliser quand l'utilisateur cite un document par son nom plutôt que par son id.",
    { nameQuery: z.string().describe("Nom ou fragment de nom, ex: 'Budget 2026'") },
    async ({ nameQuery }) => {
      const orgs = await grist.listOrgs();
      const matches = [];
      for (const org of orgs) {
        const workspaces = await grist.listWorkspaces(org.id);
        for (const ws of workspaces) {
          for (const doc of ws.docs || []) {
            if (doc.name.toLowerCase().includes(nameQuery.toLowerCase())) {
              matches.push({ docId: doc.id, docName: doc.name, workspace: ws.name, org: org.name });
            }
          }
        }
      }
      return { content: [{ type: "text", text: JSON.stringify({ matches }, null, 2) }] };
    }
  );

  server.tool(
    "describe_document",
    "Retourne les métadonnées complètes d'un document Grist : nom, workspace, " +
    "organisation, statut épinglé, droits d'accès courants.",
    { docId: zDocId },
    async ({ docId }) => {
      const d = await grist.getDoc(docId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "list_tables",
    "Liste toutes les tables d'un document Grist avec leur identifiant (tableId) et " +
    "leur nom d'affichage. À utiliser pour découvrir la structure d'un document avant " +
    "de lire ou d'écrire des données.",
    { docId: zDocId },
    async ({ docId }) => {
      const d = await grist.listTables(docId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "get_table_schema",
    "Retourne la définition complète des colonnes d'une table Grist : colId, libellés " +
    "affichés, types de données (Text, Numeric, Date, Reference...), formules Python. " +
    "À utiliser avant d'insérer des données pour connaître les noms exacts des colonnes.",
    { docId: zDocId, tableId: zTableId },
    async ({ docId, tableId }) => {
      const d = await grist.listColumns(docId, tableId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 2. LECTURE DE DONNÉES
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_table_records",
    "Récupère les lignes d'une table Grist au format JSON, avec filtre, tri et limite " +
    "optionnels. Principal point d'entrée pour 'analyser les données de la table X' : " +
    "rapatrie les données puis raisonne dessus (tendances, anomalies, résumé). " +
    "Pour des agrégations complexes sur de grandes tables, préférer run_sql_query.",
    {
      docId: zDocId,
      tableId: zTableId,
      filter: z.record(z.array(z.union([z.string(), z.number(), z.boolean()])))
        .optional()
        .describe("Filtre : { 'Colonne': [val1, val2] }. Ex: { 'Statut': ['En cours'] }"),
      limit: z.number().int().positive().max(5000).optional()
        .describe("Nombre maximum de lignes (1–5000). Omis = toutes les lignes."),
      sort: z.string().optional()
        .describe("Tri par colonne. Préfixe '-' = décroissant. Ex: '-Date' ou 'Nom'"),
    },
    async ({ docId, tableId, filter, limit, sort }) => {
      const d = await grist.getRecords(docId, tableId, { filter, limit, sort });
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "run_sql_query",
    "Exécute une requête SQL SELECT en lecture seule sur un document Grist. " +
    "Idéal pour agrégations (SUM, COUNT, AVG, GROUP BY), jointures, filtres complexes. " +
    "Le tableId est le nom SQL de la table. Supporte les paramètres '?'. " +
    "⚠️ Uniquement SELECT — pas d'INSERT/UPDATE/DELETE.",
    {
      docId: zDocId,
      sql: z.string().describe(
        "Requête SELECT. Ex: 'SELECT Categorie, SUM(Montant) as Total FROM Depenses GROUP BY Categorie'"
      ),
      args: z.array(z.union([z.string(), z.number(), z.boolean()])).optional()
        .describe("Paramètres des '?' dans la requête, dans l'ordre."),
    },
    async ({ docId, sql, args }) => {
      const d = await grist.runSql(docId, sql, args || []);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 3. ÉCRITURE DE DONNÉES (Records)
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "add_records",
    "Insère une ou plusieurs nouvelles lignes dans une table Grist. " +
    "Utiliser get_table_schema si les noms de colonnes ne sont pas connus. " +
    "Retourne les rowId des lignes créées.",
    {
      docId: zDocId,
      tableId: zTableId,
      records: z.array(z.record(z.any())).min(1)
        .describe("Lignes à insérer. Ex: [{ 'Nom': 'Alice', 'Montant': 150, 'Date': '2026-06-30' }]"),
    },
    async ({ docId, tableId, records }) => {
      const d = await grist.addRecords(docId, tableId, records);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "update_records",
    "Modifie des champs de lignes existantes, identifiées par leur rowId. " +
    "Utiliser get_table_records pour obtenir les rowId. " +
    "Seuls les champs fournis sont mis à jour (les autres restent inchangés).",
    {
      docId: zDocId,
      tableId: zTableId,
      updates: z.array(z.object({
        id: z.number().int().describe("rowId de la ligne"),
        fields: z.record(z.any()).describe("Champs à mettre à jour"),
      })).min(1),
    },
    async ({ docId, tableId, updates }) => {
      const d = await grist.updateRecords(docId, tableId, updates);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "upsert_records",
    "Ajoute ou met à jour des lignes en les identifiant par des champs-clé ('require'). " +
    "Si une ligne correspondant à 'require' existe → mise à jour avec 'fields'. " +
    "Sinon → création avec require + fields combinés. " +
    "Utile pour synchroniser des données sans créer de doublons.",
    {
      docId: zDocId,
      tableId: zTableId,
      records: z.array(z.object({
        require: z.record(z.any())
          .describe("Critères d'identification. Ex: { 'Email': 'alice@ex.fr' }"),
        fields: z.record(z.any())
          .describe("Champs à créer/mettre à jour. Ex: { 'Nom': 'Alice', 'Actif': true }"),
      })).min(1),
    },
    async ({ docId, tableId, records }) => {
      const d = await grist.upsertRecords(docId, tableId, records);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "delete_records",
    "⚠️ Supprime définitivement des lignes d'une table Grist (irréversible). " +
    "N'utiliser que sur demande explicite. Utiliser get_table_records pour obtenir les rowId.",
    {
      docId: zDocId,
      tableId: zTableId,
      rowIds: z.array(z.number().int()).min(1).describe("rowId des lignes à supprimer. Ex: [3, 7, 12]"),
    },
    async ({ docId, tableId, rowIds }) => {
      const d = await grist.deleteRecords(docId, tableId, rowIds);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 4. SCHÉMA — TABLES
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "create_table",
    "Crée une ou plusieurs nouvelles tables dans un document Grist, avec leurs colonnes " +
    "initiales. Le tableId doit être un identifiant Python valide (lettres, chiffres, underscores).",
    {
      docId: zDocId,
      tables: z.array(z.object({
        id: z.string().describe("tableId, ex: 'Clients'"),
        columns: z.array(z.object({
          id: z.string(),
          fields: z.object({
            label: z.string().optional(),
            type: z.string().optional()
              .describe("'Text'|'Numeric'|'Int'|'Bool'|'Date'|'DateTime'|'Choice'|'Reference'|'Attachments'"),
          }).optional(),
        })).optional().describe("Colonnes initiales (ajout ultérieur possible avec add_columns)"),
      })).min(1),
    },
    async ({ docId, tables }) => {
      const d = await grist.createTables(docId, tables);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "update_table_metadata",
    "Modifie les métadonnées d'une table Grist (ex: son nom d'affichage). " +
    "Pour renommer le tableId technique (utilisé dans les formules), " +
    "utiliser apply_user_actions avec l'action 'RenameTable'.",
    {
      docId: zDocId,
      tables: z.array(z.object({
        id: z.string().describe("tableId actuel"),
        fields: z.record(z.any()).describe("Métadonnées à modifier"),
      })).min(1),
    },
    async ({ docId, tables }) => {
      const d = await grist.updateTables(docId, tables);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "delete_table",
    "⚠️ Supprime définitivement une table et toutes ses données (irréversible). " +
    "N'utiliser que sur demande explicite de l'utilisateur.",
    { docId: zDocId, tableId: zTableId },
    async ({ docId, tableId }) => {
      const d = await grist.deleteTable(docId, tableId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 5. SCHÉMA — COLONNES
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "add_columns",
    "Ajoute de nouvelles colonnes à une table Grist. Spécifier le type et un libellé. " +
    "Les colonnes de formule doivent avoir isFormula=true et une expression Python dans formula.",
    { docId: zDocId, tableId: zTableId, columns: z.array(zColumnDef).min(1) },
    async ({ docId, tableId, columns }) => {
      const d = await grist.addColumns(docId, tableId, columns);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "update_columns",
    "Modifie les propriétés de colonnes existantes : libellé, type, formule, etc. " +
    "Seules les propriétés fournies sont modifiées. " +
    "Pour changer le colId (nom technique), utiliser apply_user_actions avec 'RenameColumn'.",
    {
      docId: zDocId,
      tableId: zTableId,
      columns: z.array(zColumnDef).min(1)
        .describe("Colonnes à modifier. 'id' identifie la colonne cible."),
    },
    async ({ docId, tableId, columns }) => {
      const d = await grist.updateColumns(docId, tableId, columns);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "upsert_columns",
    "Ajoute une colonne si elle n'existe pas, ou la met à jour si elle existe " +
    "(identifiée par son colId). Idempotent.",
    { docId: zDocId, tableId: zTableId, columns: z.array(zColumnDef).min(1) },
    async ({ docId, tableId, columns }) => {
      const d = await grist.upsertColumns(docId, tableId, columns);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "delete_column",
    "⚠️ Supprime définitivement une colonne et toutes ses données (irréversible). " +
    "N'utiliser que sur demande explicite.",
    {
      docId: zDocId,
      tableId: zTableId,
      colId: z.string().describe("colId technique de la colonne à supprimer"),
    },
    async ({ docId, tableId, colId }) => {
      const d = await grist.deleteColumn(docId, tableId, colId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 6. DOCUMENTS — CYCLE DE VIE
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "create_document",
    "Crée un nouveau document Grist vide dans un workspace. Retourne le docId.",
    {
      workspaceId: zWsId,
      name: z.string().describe("Nom du nouveau document"),
      isPinned: z.boolean().optional().describe("true = épingler en haut du workspace"),
    },
    async ({ workspaceId, name, isPinned }) => {
      const d = await grist.createDoc(workspaceId, { name, isPinned });
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "rename_document",
    "Renomme un document Grist.",
    { docId: zDocId, name: z.string().describe("Nouveau nom") },
    async ({ docId, name }) => {
      const d = await grist.updateDoc(docId, { name });
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "copy_document",
    "Copie un document Grist vers un workspace. " +
    "asTemplate=true copie uniquement la structure (sans données ni historique).",
    {
      docId: zDocId,
      workspaceId: zWsId.describe("Workspace de destination"),
      documentName: z.string().describe("Nom du document copié"),
      asTemplate: z.boolean().optional().describe("true = structure seulement (gabarit)"),
    },
    async ({ docId, workspaceId, documentName, asTemplate }) => {
      const d = await grist.copyDoc(docId, { workspaceId, documentName, asTemplate: !!asTemplate });
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "fork_document",
    "Crée un fork personnel d'un document Grist (copie qui garde la référence au document " +
    "original / trunk). Utile pour expérimenter des modifications avant de les soumettre. " +
    "Retourne forkId et le nouveau docId.",
    { docId: zDocId },
    async ({ docId }) => {
      const d = await grist.forkDoc(docId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "move_document",
    "Déplace un document Grist vers un autre workspace (au sein du même site).",
    {
      docId: zDocId,
      workspaceId: zWsId.describe("ID du workspace de destination"),
    },
    async ({ docId, workspaceId }) => {
      const d = await grist.moveDoc(docId, workspaceId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "pin_document",
    "Épingle (pin=true) ou désépingle (pin=false) un document Grist. " +
    "Les documents épinglés apparaissent en haut de la liste du workspace.",
    {
      docId: zDocId,
      pin: z.boolean().describe("true = épingler, false = désépingler"),
    },
    async ({ docId, pin }) => {
      const d = pin ? await grist.pinDoc(docId) : await grist.unpinDoc(docId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "trash_document",
    "Déplace un document Grist vers la corbeille (suppression douce, restaurable). " +
    "permanent=true supprime définitivement ⚠️ (irréversible).",
    {
      docId: zDocId,
      permanent: z.boolean().optional()
        .describe("true = suppression permanente ⚠️. Par défaut: false (corbeille)."),
    },
    async ({ docId, permanent }) => {
      const d = await grist.trashDoc(docId, !!permanent);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "restore_document",
    "Restaure un document Grist depuis la corbeille. " +
    "Ne fonctionne que si le document n'a pas été supprimé définitivement.",
    { docId: zDocId },
    async ({ docId }) => {
      const d = await grist.restoreDoc(docId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "delete_document",
    "⚠️ Supprime définitivement un document Grist (irréversible). " +
    "Préférer trash_document si une restauration pourrait être nécessaire.",
    { docId: zDocId },
    async ({ docId }) => {
      const d = await grist.deleteDoc(docId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 7. WORKSPACES
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "create_workspace",
    "Crée un nouveau workspace dans une organisation Grist. Retourne son id.",
    { orgId: zOrgId, name: z.string().describe("Nom du workspace") },
    async ({ orgId, name }) => {
      const d = await grist.createWorkspace(orgId, name);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "rename_workspace",
    "Renomme un workspace Grist.",
    { workspaceId: zWsId, name: z.string().describe("Nouveau nom") },
    async ({ workspaceId, name }) => {
      const d = await grist.updateWorkspace(workspaceId, name);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "trash_workspace",
    "Déplace un workspace et ses documents vers la corbeille. " +
    "permanent=true supprime définitivement ⚠️.",
    {
      workspaceId: zWsId,
      permanent: z.boolean().optional().describe("true = suppression permanente ⚠️. Défaut: false."),
    },
    async ({ workspaceId, permanent }) => {
      const d = await grist.trashWorkspace(workspaceId, !!permanent);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "restore_workspace",
    "Restaure un workspace depuis la corbeille.",
    { workspaceId: zWsId },
    async ({ workspaceId }) => {
      const d = await grist.restoreWorkspace(workspaceId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "delete_workspace",
    "⚠️ Supprime définitivement un workspace Grist et tous ses documents (irréversible).",
    { workspaceId: zWsId },
    async ({ workspaceId }) => {
      const d = await grist.deleteWorkspace(workspaceId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 8. CONTRÔLE D'ACCÈS
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_document_access",
    "Retourne la liste des utilisateurs et leurs rôles sur un document Grist " +
    "(owners, editors, viewers) ainsi que le rôle maximum hérité du workspace.",
    { docId: zDocId },
    async ({ docId }) => {
      const d = await grist.getDocAccess(docId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "update_document_access",
    "Invite, retire ou change le rôle d'utilisateurs sur un document Grist. " +
    "{ 'email': 'editors' } = accorder l'accès, { 'email': null } = retirer l'accès. " +
    "Rôles : 'owners', 'editors', 'viewers'.",
    {
      docId: zDocId,
      delta: z.object({
        users: z.record(zRole)
          .describe("Map email → rôle. Ex: { 'alice@ex.fr': 'editors', 'bob@ex.fr': null }"),
        maxInheritedRole: zRole.optional()
          .describe("Rôle hérité max du workspace. null = désactiver l'héritage."),
      }),
    },
    async ({ docId, delta }) => {
      const d = await grist.updateDocAccess(docId, delta);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "get_workspace_access",
    "Retourne la liste des utilisateurs et leurs rôles sur un workspace Grist.",
    { workspaceId: zWsId },
    async ({ workspaceId }) => {
      const d = await grist.getWorkspaceAccess(workspaceId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "update_workspace_access",
    "Invite, retire ou change le rôle d'utilisateurs sur un workspace Grist. " +
    "Les changements s'appliquent à tous ses documents (sauf surcharge spécifique au document).",
    {
      workspaceId: zWsId,
      delta: z.object({
        users: z.record(zRole).describe("Map email → rôle. null = retirer l'accès."),
        maxInheritedRole: zRole.optional(),
      }),
    },
    async ({ workspaceId, delta }) => {
      const d = await grist.updateWorkspaceAccess(workspaceId, delta);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 9. EXPORTS & TÉLÉCHARGEMENTS
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_download_url",
    "Construit une URL de téléchargement authentifiée (token API intégré) pour exporter " +
    "des données Grist. L'URL s'ouvre directement dans un navigateur ou avec curl. " +
    "Formats disponibles :\n" +
    "  'csv'    → table en CSV (texte, en-têtes configurables)\n" +
    "  'tsv'    → table en TSV (séparateur tabulation)\n" +
    "  'xlsx'   → document ou table en Excel\n" +
    "  'sqlite' → document complet en SQLite\n" +
    "  'schema' → schéma frictionless JSON de la table",
    {
      docId: zDocId,
      format: z.enum(["csv", "tsv", "xlsx", "sqlite", "schema"]).describe("Format d'export"),
      tableId: z.string().optional().describe("Requis pour csv, tsv, schema. Optionnel pour xlsx."),
      header: z.enum(["label", "colId"]).optional()
        .describe("Format des en-têtes csv/tsv/xlsx. 'label' = noms lisibles (défaut), 'colId' = identifiants techniques."),
      nohistory: z.boolean().optional()
        .describe("Pour 'sqlite' : true = exclure l'historique (fichier plus léger)."),
    },
    async ({ docId, format, tableId, header, nohistory }) => {
      const params = {};
      if (header) params.header = header;
      if (tableId) params.tableId = tableId;
      if (nohistory) params.nohistory = "true";

      const paths = {
        csv: `/docs/${docId}/download/csv`,
        tsv: `/docs/${docId}/download/tsv`,
        xlsx: `/docs/${docId}/download/xlsx`,
        sqlite: `/docs/${docId}/download`,
        schema: `/docs/${docId}/download/table-schema`,
      };
      const url = downloadUrl(paths[format], params);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            url,
            note: "URL avec token intégrée. Ouvrir dans un navigateur ou télécharger avec curl/wget.",
          }, null, 2),
        }],
      };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 10. SNAPSHOTS & HISTORIQUE
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "list_snapshots",
    "Liste les snapshots (sauvegardes automatiques) d'un document Grist, du plus récent " +
    "au plus ancien. Chaque snapshot a un snapshotId et une date. " +
    "À utiliser avant une restauration pour choisir le bon point de retour.",
    { docId: zDocId },
    async ({ docId }) => {
      const d = await grist.listSnapshots(docId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "restore_from_snapshot",
    "⚠️ Restaure le contenu d'un document Grist à l'état d'un snapshot. " +
    "L'état actuel est remplacé. Utiliser list_snapshots pour obtenir le snapshotId.",
    {
      docId: zDocId,
      snapshotId: z.string().describe("ID du snapshot (via list_snapshots)"),
    },
    async ({ docId, snapshotId }) => {
      const d = await grist.replaceDoc(docId, { snapshotId });
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "get_document_history",
    "Retourne l'historique des actions d'un document Grist : liste ordonnée des états " +
    "(numéro séquentiel n et hash h). Utile pour comparer des versions ou tronquer l'historique.",
    { docId: zDocId },
    async ({ docId }) => {
      const d = await grist.getDocStates(docId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "truncate_document_history",
    "Supprime les anciennes entrées de l'historique des actions, en ne conservant " +
    "que les 'keep' plus récentes. Réduit la taille du fichier document.",
    {
      docId: zDocId,
      keep: z.number().int().positive().describe("Nombre d'entrées récentes à conserver"),
    },
    async ({ docId, keep }) => {
      const d = await grist.truncateHistory(docId, keep);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "compare_document_versions",
    "Compare deux versions d'un document (par hash d'état) ou deux documents distincts " +
    "(ex: fork ↔ trunk). Retourne un résumé des changements et les détails des modifications. " +
    "Utiliser get_document_history pour obtenir les hashes.",
    {
      docId: zDocId,
      docId2: z.string().optional()
        .describe("docId d'un second document (pour comparer fork ↔ trunk). Vide = comparer deux versions du même doc."),
      leftHash: z.string().optional().describe("Hash de la version gauche (de get_document_history). Défaut: HEAD"),
      rightHash: z.string().optional().describe("Hash de la version droite. Défaut: HEAD"),
    },
    async ({ docId, docId2, leftHash, rightHash }) => {
      const d = docId2
        ? await grist.compareDocs(docId, docId2)
        : await grist.compareVersions(docId, leftHash, rightHash);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 11. WEBHOOKS
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "list_webhooks",
    "Liste les webhooks configurés sur un document Grist avec leurs paramètres " +
    "(URL, tables, types d'événements, statut activé/désactivé) et statistiques de livraison.",
    { docId: zDocId },
    async ({ docId }) => {
      const d = await grist.listWebhooks(docId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "create_webhook",
    "Crée un webhook sur un document Grist pour être notifié de changements de données. " +
    "eventTypes : 'add' (ajout de lignes) et/ou 'update' (modification). " +
    "isReadyColumn : colId d'une colonne booléenne — attend qu'elle soit vraie avant d'envoyer.",
    {
      docId: zDocId,
      webhooks: z.array(z.object({
        fields: z.object({
          url: z.string().url().describe("URL de destination"),
          eventTypes: z.array(z.enum(["add", "update"])).describe("Événements déclencheurs"),
          tableId: z.string().describe("Table à surveiller"),
          name: z.string().optional().describe("Nom descriptif"),
          memo: z.string().optional().describe("Description"),
          enabled: z.boolean().optional().describe("Activer immédiatement (défaut: true)"),
          isReadyColumn: z.string().nullable().optional()
            .describe("colId d'une colonne booléenne de déclenchement"),
        }),
      })).min(1),
    },
    async ({ docId, webhooks }) => {
      const d = await grist.createWebhooks(docId, webhooks);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "update_webhook",
    "Modifie les paramètres d'un webhook existant (URL, événements, activation, etc.).",
    {
      docId: zDocId,
      webhookId: z.string().describe("ID du webhook (via list_webhooks)"),
      fields: z.object({
        url: z.string().url().optional(),
        eventTypes: z.array(z.enum(["add", "update"])).optional(),
        tableId: z.string().optional(),
        name: z.string().optional(),
        memo: z.string().optional(),
        enabled: z.boolean().optional(),
        isReadyColumn: z.string().nullable().optional(),
      }),
    },
    async ({ docId, webhookId, fields }) => {
      const d = await grist.updateWebhook(docId, webhookId, fields);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "delete_webhook",
    "Supprime un webhook d'un document Grist.",
    {
      docId: zDocId,
      webhookId: z.string().describe("ID du webhook (via list_webhooks)"),
    },
    async ({ docId, webhookId }) => {
      const d = await grist.deleteWebhook(docId, webhookId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "clear_webhook_queue",
    "Vide la file d'attente des webhooks non livrés d'un document Grist. " +
    "Utile si les webhooks sont bloqués suite à un incident sur le serveur destinataire.",
    { docId: zDocId },
    async ({ docId }) => {
      const d = await grist.clearWebhookQueue(docId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 12. PIÈCES JOINTES
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "list_attachments",
    "Liste les métadonnées de toutes les pièces jointes d'un document Grist : " +
    "nom de fichier, taille, type MIME, date d'upload et identifiant numérique.",
    { docId: zDocId },
    async ({ docId }) => {
      const d = await grist.listAttachments(docId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "get_attachment_info",
    "Retourne les métadonnées d'une pièce jointe spécifique " +
    "et une URL de téléchargement authentifiée (ouvrable dans un navigateur).",
    {
      docId: zDocId,
      attachmentId: z.number().int().describe("ID de la pièce jointe (via list_attachments)"),
    },
    async ({ docId, attachmentId }) => {
      const meta = await grist.getAttachment(docId, attachmentId);
      const dlUrl = downloadUrl(`/docs/${docId}/attachments/${attachmentId}/download`);
      return {
        content: [{ type: "text", text: JSON.stringify({ ...meta, downloadUrl: dlUrl }, null, 2) }],
      };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 13. ACTIONS BAS-NIVEAU (format interne Grist)
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "apply_user_actions",
    "Applique une séquence d'actions bas-niveau Grist en une transaction. " +
    "Format : tableau d'actions, chaque action étant elle-même un tableau. " +
    "À utiliser pour des opérations non couvertes par les autres outils (renommer un colId, " +
    "combiner ajout de colonne + insertion de données en une seule requête, etc.).\n\n" +
    "Actions principales :\n" +
    "  ['AddRecord', tableId, null, {col: val}]                    → ajouter une ligne\n" +
    "  ['UpdateRecord', tableId, rowId, {col: val}]                → modifier une ligne\n" +
    "  ['RemoveRecord', tableId, rowId]                            → supprimer une ligne\n" +
    "  ['BulkAddRecord', tableId, [null,null], {col:[v1,v2]}]      → ajouter N lignes\n" +
    "  ['BulkUpdateRecord', tableId, [r1,r2], {col:[v1,v2]}]       → modifier N lignes\n" +
    "  ['BulkRemoveRecord', tableId, [r1,r2]]                      → supprimer N lignes\n" +
    "  ['AddColumn', tableId, colId, {type, label}]                → ajouter une colonne\n" +
    "  ['RemoveColumn', tableId, colId]                            → supprimer une colonne\n" +
    "  ['RenameColumn', tableId, oldColId, newColId]               → renommer un colId\n" +
    "  ['AddTable', newTableId, [{id, type}]]                      → créer une table\n" +
    "  ['RemoveTable', tableId]                                    → supprimer une table\n" +
    "  ['RenameTable', oldId, newId]                               → renommer tableId",
    {
      docId: zDocId,
      actions: z.array(z.array(z.any())).min(1)
        .describe("Ex: [[\"AddRecord\",\"Clients\",null,{\"Nom\":\"Dupont\"}]]"),
      noparse: z.boolean().optional()
        .describe("true = stocker les chaînes sans conversion automatique (dates, nombres). Défaut: false."),
    },
    async ({ docId, actions, noparse }) => {
      const d = await grist.applyActions(docId, actions, !!noparse);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 14. ADMIN & PERFORMANCE
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "reload_document",
    "Force le rechargement d'un document Grist (redémarre le moteur de formules Python). " +
    "Non destructif : les données ne sont pas modifiées. " +
    "À utiliser si des formules sont bloquées ou si le document est dans un état incohérent.",
    { docId: zDocId },
    async ({ docId }) => {
      const d = await grist.reloadDoc(docId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "flush_document",
    "Force l'écriture immédiate de toutes les modifications en attente d'un document " +
    "Grist vers le stockage persistant. Utile avant une opération critique.",
    { docId: zDocId },
    async ({ docId }) => {
      const d = await grist.flushDoc(docId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "manage_formula_timing",
    "Démarre, arrête ou consulte le chronomètre de performance des formules Grist. " +
    "'start' = commencer la mesure, 'stop' = arrêter et retourner les temps par formule, " +
    "'status' = consulter l'état sans modifier. Utile pour identifier les formules lentes.",
    {
      docId: zDocId,
      action: z.enum(["start", "stop", "status"])
        .describe("'start' | 'stop' | 'status'"),
    },
    async ({ docId, action }) => {
      const d = action === "start" ? await grist.startTiming(docId)
        : action === "stop" ? await grist.stopTiming(docId)
          : await grist.getTimingStatus(docId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 15. ORGANISATION & PROFIL
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_org_usage",
    "Retourne les statistiques d'utilisation d'une organisation Grist : nombre de documents " +
    "selon leur statut de limite de données, utilisation des pièces jointes (octets). " +
    "Accessible uniquement aux propriétaires de l'organisation.",
    { orgId: zOrgId },
    async ({ orgId }) => {
      const d = await grist.getOrgUsage(orgId);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  server.tool(
    "get_current_user",
    "Retourne le profil de l'utilisateur authentifié par la clé API configurée : " +
    "nom, email, locale, avatar. Utile pour vérifier quelle clé API est active.",
    {},
    async () => {
      const d = await grist.getProfile();
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 16. UPLOAD DE PJ
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "upload_attachments",
    "Téléverse une ou plusieurs pièces jointes vers un document Grist " +
    "(multipart/form-data sur /docs/{docId}/attachments). Le contenu du fichier doit être " +
    "fourni encodé en base64. Retourne les identifiants numériques des pièces jointes créées, " +
    "réutilisables ensuite dans une colonne de type 'Attachments' (via add_records/update_records) " +
    "en les associant à un rowId de la table _grist_Attachments ou directement par leur id.",
    {
      docId: zDocId,
      files: z.array(z.object({
        filename: z.string().describe("Nom du fichier, ex: 'facture.pdf'"),
        contentBase64: z.string().describe("Contenu du fichier encodé en base64"),
        contentType: z.string().optional().describe("Type MIME, ex: 'application/pdf'. Détecté sinon."),
      })).min(1).describe("Fichiers à téléverser"),
    },
    async ({ docId, files }) => {
      const decoded = files.map((f) => ({
        filename: f.filename,
        content: Buffer.from(f.contentBase64, "base64"),
        contentType: f.contentType,
      }));
      const d = await grist.addAttachments(docId, decoded);
      return { content: [{ type: "text", text: JSON.stringify({ attachmentIds: d }, null, 2) }] };
    }
  );

} // fin registerGristTools
