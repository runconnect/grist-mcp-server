# Grist MCP Server

Micro-service HTTP autonome qui expose des **outils MCP** permettant à un client comme
**Perplexity** de lire et d'écrire dans des documents Grist en langage naturel.

## Comment ça marche (important à comprendre)

Ce n'est **pas** ce micro-service qui "comprend" le français. Dans le protocole MCP :

1. L'utilisateur écrit dans Perplexity : *"Ajoute une ligne avec Nom=Dupont, Montant=120
   dans la table Depenses"*.
2. Le **modèle de Perplexity** (lui-même) lit la liste des outils exposés par ce serveur
   (leurs noms, descriptions, paramètres) et décide d'appeler `add_records` avec les bons
   arguments JSON (`docId`, `tableId`, `records`).
3. Ce micro-service reçoit cet appel JSON-RPC structuré, traduit en appel HTTP vers
   l'API REST de Grist, puis renvoie le résultat à Perplexity, qui le reformule en français.

Votre travail (déjà fait dans ce dépôt) consiste donc surtout à :
- exposer des outils avec des **descriptions et schémas très clairs** (c'est ce qui guide
  le modèle de Perplexity),
- traduire ces outils en appels à l'API Grist (`/api/docs/{docId}/tables/{tableId}/records`,
  etc.).

## Outils exposés (~51 outils)

### 1. Navigation & découverte
| Outil | Usage |
|---|---|
| `list_orgs` | Lister les sites Grist accessibles |
| `list_workspaces` | Lister les workspaces/documents d'une organisation |
| `find_document` | Retrouver un `docId` à partir du nom du document |
| `describe_document` | Métadonnées complètes d'un document |
| `list_tables` | Lister les tables d'un document |
| `get_table_schema` | Lister les colonnes d'une table |

### 2. Lecture de données
| Outil | Usage |
|---|---|
| `get_table_records` | Lire des lignes (avec filtre/tri/limite) |
| `run_sql_query` | SELECT SQL en lecture seule, pour des agrégations |

### 3. Écriture de données
| Outil | Usage |
|---|---|
| `add_records` | Ajouter une ou plusieurs lignes |
| `update_records` | Modifier des lignes existantes |
| `upsert_records` | Ajouter ou mettre à jour selon des critères-clé |
| `delete_records` | ⚠️ Supprimer des lignes (irréversible) |

### 4. Schéma — Tables
| Outil | Usage |
|---|---|
| `create_table` | Créer une ou plusieurs tables |
| `update_table_metadata` | Modifier les métadonnées d'une table |
| `delete_table` | ⚠️ Supprimer une table (irréversible) |

### 5. Schéma — Colonnes
| Outil | Usage |
|---|---|
| `add_columns` | Ajouter des colonnes |
| `update_columns` | Modifier des colonnes existantes |
| `upsert_columns` | Ajouter ou mettre à jour une colonne |
| `delete_column` | ⚠️ Supprimer une colonne (irréversible) |

### 6. Documents — Cycle de vie
| Outil | Usage |
|---|---|
| `create_document` | Créer un document vide |
| `rename_document` | Renommer un document |
| `copy_document` | Copier un document (ou son gabarit) |
| `fork_document` | Créer un fork personnel |
| `move_document` | Déplacer vers un autre workspace |
| `pin_document` | Épingler/désépingler |
| `trash_document` | Corbeille (ou suppression permanente ⚠️) |
| `restore_document` | Restaurer depuis la corbeille |
| `delete_document` | ⚠️ Supprimer définitivement |

### 7. Workspaces
| Outil | Usage |
|---|---|
| `create_workspace` | Créer un workspace |
| `rename_workspace` | Renommer un workspace |
| `trash_workspace` | Corbeille (ou suppression permanente ⚠️) |
| `restore_workspace` | Restaurer depuis la corbeille |
| `delete_workspace` | ⚠️ Supprimer définitivement (et tous ses documents) |

### 8. Contrôle d'accès
| Outil | Usage |
|---|---|
| `get_document_access` | Lister les rôles utilisateurs sur un document |
| `update_document_access` | Inviter/retirer/changer un rôle sur un document |
| `get_workspace_access` | Lister les rôles utilisateurs sur un workspace |
| `update_workspace_access` | Inviter/retirer/changer un rôle sur un workspace |

### 9. Exports & téléchargements
| Outil | Usage |
|---|---|
| `get_download_url` | URL authentifiée : CSV, TSV, XLSX, SQLite, schéma |

### 10. Snapshots & historique
| Outil | Usage |
|---|---|
| `list_snapshots` | Lister les sauvegardes automatiques |
| `restore_from_snapshot` | ⚠️ Restaurer un document à un snapshot |
| `get_document_history` | Historique des actions (états/hashes) |
| `truncate_document_history` | Réduire la taille de l'historique |
| `compare_document_versions` | Comparer deux versions ou deux documents |

### 11. Webhooks
| Outil | Usage |
|---|---|
| `list_webhooks` | Lister les webhooks configurés |
| `create_webhook` | Créer un webhook (add/update) |
| `update_webhook` | Modifier un webhook existant |
| `delete_webhook` | Supprimer un webhook |
| `clear_webhook_queue` | Vider la file d'attente non livrée |

### 12. Pièces jointes
| Outil | Usage |
|---|---|
| `list_attachments` | Lister les métadonnées des pièces jointes |
| `get_attachment_info` | Métadonnées + URL de téléchargement d'une pièce jointe |
| `upload_attachments` | Téléverser une ou plusieurs pièces jointes (base64 → multipart/form-data) |

### 13. Actions bas-niveau
| Outil | Usage |
|---|---|
| `apply_user_actions` | Appliquer des actions internes Grist (AddRecord, RenameColumn, RenameTable, etc.) — pour tout ce que les autres outils ne couvrent pas |

### 14. Admin & performance
| Outil | Usage |
|---|---|
| `reload_document` | Forcer le rechargement (redémarre le moteur de formules) |
| `flush_document` | Forcer l'écriture immédiate sur disque |
| `manage_formula_timing` | Démarrer/arrêter/consulter le chronomètre de performance des formules |

### 15. Organisation & profil
| Outil | Usage |
|---|---|
| `get_org_usage` | Statistiques d'utilisation d'une organisation (docs, pièces jointes) |
| `get_current_user` | Profil de l'utilisateur authentifié par la clé API |

Pour la demande *"Analyse les données de la table X du document Y"*, Perplexity enchaînera
typiquement : `find_document` (si Y est un nom) → `list_tables`/`get_table_schema` →
`get_table_records` (ou `run_sql_query` pour une agrégation), puis fera l'analyse lui-même
à partir des données renvoyées.

Pour *"Attache ce fichier à la ligne X"* : `upload_attachments` (retourne un ou plusieurs
IDs numériques) → `update_records` en assignant ces IDs à une colonne de type `Attachments`.

## Installation

```bash
cp .env.example .env
# éditez .env : GRIST_API_KEY, GRIST_API_URL, MCP_SERVER_TOKEN
npm install
npm start
```

Le serveur écoute sur `http://localhost:3939/mcp`.

### Récupérer une clé API Grist

Compte Grist > **Account settings** > **Developer** > **API keys** > Create.
⚠️ Cette clé a les mêmes droits que votre compte sur tous vos documents. Pour limiter le
risque, créez idéalement un compte Grist dédié ("service account") qui n'a accès qu'aux
documents que vous voulez exposer à Perplexity, et utilisez sa clé API ici.

### Tester en local

Avant de brancher Perplexity, vous pouvez tester avec
[MCP Inspector](https://github.com/modelcontextprotocol/inspector) :

```bash
npx @modelcontextprotocol/inspector
# puis dans l'UI : URL = http://localhost:3939/mcp, Transport = Streamable HTTP
# Header: Authorization: Bearer <votre MCP_SERVER_TOKEN>
```

## Déploiement

Perplexity exige une URL **publique en HTTPS**. Quelques options simples :

- **Test rapide** : `ngrok http 3939` puis utilisez l'URL `https://xxxx.ngrok-free.app/mcp`.
- **Production légère** : déployez sur Render, Railway, Fly.io ou un petit VPS (avec
  Nginx/Caddy en reverse proxy pour le TLS). Le service est sans état persistant côté
  disque (tout passe par l'API Grist), donc une seule instance suffit largement, mais
  pensez à un stockage de session externe (Redis) si vous scalez à plusieurs instances,
  car `transports` est actuellement en mémoire.

Variables d'environnement à définir sur la plateforme de déploiement : `GRIST_API_KEY`,
`GRIST_API_URL`, `MCP_SERVER_TOKEN`, `PORT` (souvent imposé par la plateforme).

Note pour `upload_attachments` : la taille maximale d'un fichier accepté dépend de la
limite configurée sur votre document/site Grist ainsi que de la limite de payload de votre
plateforme d'hébergement (souvent quelques Mo par défaut sur Render/Railway) — augmentez-la
si vous prévoyez des pièces jointes volumineuses. L'encodage base64 augmente la taille du
fichier d'environ 33% par rapport à l'original.

## Connecter à Perplexity

Dans Perplexity : **Account settings > Connectors > + Custom connector > Remote**

- **Name** : Grist
- **MCP Server URL** : `https://votre-domaine.tld/mcp`
- **Authentication** : API Key → collez la valeur de `MCP_SERVER_TOKEN`
- **Transport** : Streamable HTTP
- Cochez la case de confirmation des risques, puis **Add**, puis activez le connecteur.

Activez ensuite le connecteur "Grist" sous **Sources** dans une conversation, et testez :

> "Liste les tables du document Suivi Budget"
> "Analyse les données de la table Depenses du document Suivi Budget"
> "Ajoute une ligne dans la table Depenses avec Nom=Taxi, Montant=35, Date=2026-06-30"
> "Téléverse ce fichier et attache-le à la ligne 12 de la table Depenses"

## Sécurité — pistes d'amélioration

- Remplacer la clé API Grist statique par une **app OAuth Grist** (voir la doc Grist sur
  les "Connected apps"), qui permet d'autoriser l'accès à des documents précis et de
  révoquer l'accès indépendamment du compte utilisateur — plus sûr qu'une clé API globale.
- Ajouter une journalisation des appels d'outils (qui a fait quoi, quand) si plusieurs
  personnes partagent ce connecteur.
- Restreindre ou retirer les outils destructifs si vous ne voulez pas que l'IA puisse
  supprimer des données ou de la structure : `delete_records`, `delete_table`,
  `delete_column`, `delete_document`, `delete_workspace`, `restore_from_snapshot`
  (remplace l'état courant), et `apply_user_actions` (accès bas-niveau très permissif).
- Limiter la taille et les types MIME acceptés par `upload_attachments` côté serveur si le
  connecteur est partagé, pour éviter les abus de stockage ou l'upload de fichiers non désirés.
- Envisager de retirer `get_org_usage` et `get_current_user` du périmètre exposé si le
  connecteur est partagé par plusieurs utilisateurs, ces outils exposant des informations
  de compte potentiellement sensibles.
