# Puissance 4

Jeu de puissance 4 en ligne : on défie quelqu'un en lui envoyant un **code à 6 caractères**
(ou un lien). Compte utilisateur, historique des parties et statistiques détaillées.

- **Les jaunes commencent toujours**, mais la couleur de chaque joueur est **tirée au sort**
  au moment où l'adversaire rejoint la partie.
- **30 secondes par coup** : passé ce délai, un coup est joué au hasard.
- **Mode solo** contre l'ordinateur, en trois niveaux.
- **Classement Elo** entre les joueurs.
- Front : HTML/CSS/JS en modules ES, **aucune étape de build**.
- Back : **Supabase** (Postgres + Auth + Realtime), projet `puissance4`
  (`https://czsdwhxlaowuwhhlytja.supabase.co`, région `eu-west-3`).

## Lancer en local

```bash
python -m http.server 4173
```

Puis ouvrir <http://localhost:4173>. (N'importe quel serveur statique convient :
`npx serve`, `php -S localhost:4173`, extension Live Server…) Ouvrir le fichier en `file://`
ne marche pas : les modules ES ont besoin d'un serveur.

Pour tester à deux sur la même machine, utiliser une fenêtre de navigation privée pour le
second joueur (les sessions Supabase sont stockées par origine).

### Avant la première inscription

Par défaut Supabase envoie un mail de confirmation. Pour tester sans boîte mail :
dashboard Supabase → **Authentication → Sign In / Providers → Email** → décocher
*Confirm email*. L'application gère les deux cas (elle affiche « confirme ton adresse »
si la session n'est pas ouverte immédiatement).

## Déroulement d'une partie

**L'horloge.** Chaque tour dure 30 secondes. Le compte à rebours affiché n'est
qu'un indicateur : c'est `timeout_move` qui tranche, en comparant l'heure du serveur
à `games.turn_started_at`. Les deux navigateurs peuvent le signaler — celui dont c'est
le tour d'abord, l'autre après trois secondes de grâce, ce qui couvre le cas de
l'adversaire qui a fermé son onglet. Le coup automatique est tiré au hasard parmi les
colonnes libres et enregistré avec `moves.source = 'timeout'`.

**Le mode solo.** L'adversaire est un minimax avec élagage alpha-bêta
([src/ai.js](src/ai.js)), exécuté dans le navigateur. Trois niveaux : *Facile* ne
regarde qu'un coup (il gagne ou bloque, sinon joue au hasard), *Moyen* explore
4 demi-coups, *Difficile* 7 — environ 250 ms de réflexion, et 10 victoires sur 10
contre le niveau facile. Comme ces parties ne comptent pas au classement, le
navigateur a le droit de jouer les deux couleurs : tricher ne nuirait qu'à soi-même.

**Le classement Elo.** Tout le monde démarre à 1000. Le facteur K vaut 40 pendant les
dix premières parties classées, puis 24. Seuls les duels comptent, abandons compris —
sinon il suffirait de quitter pour ne jamais perdre de points. Le calcul se fait côté
serveur au moment où la partie se termine, et la variation est affichée en fin de
partie et dans l'historique.

**La revanche.** Elle se demande et s'accepte : `request_rematch` enregistre la
demande, l'adversaire voit apparaître *Accepter* / *Refuser*, et la nouvelle partie
n'est créée qu'après `accept_rematch`. Si les deux la demandent chacun de leur côté,
la seconde demande vaut acceptation. En solo, la question ne se pose pas : une
nouvelle partie démarre aussitôt.

## Connexion

- **Inscription** : pseudo + e-mail + mot de passe. Le pseudo est vérifié comme
  disponible avant l'envoi (`username_available`), et il est unique sans tenir compte
  de la casse.
- **Connexion** : **pseudo ou e-mail** + mot de passe, dans un seul champ.
  Avec un e-mail, le navigateur parle directement à GoTrue. Avec un pseudo, il passe par
  l'edge function `signin`, la seule habilitée à retrouver l'e-mail correspondant
  (via `email_for_username`, réservée au `service_role`) : aucune adresse e-mail n'est
  jamais exposée au navigateur. Un pseudo inconnu et un mot de passe faux renvoient la
  même réponse, pour empêcher l'énumération des pseudos.

- **Mot de passe oublié** : depuis l'écran de connexion, à partir d'un pseudo ou d'un
  e-mail. La demande passe par l'edge function `recover`, qui répond toujours la même
  chose que le compte existe ou non. Le lien reçu ramène sur l'application, qui affiche
  alors un écran « Nouveau mot de passe ».

## Onglet Compte

Affiche le pseudo, l'e-mail et la date d'inscription, et permet de changer :

- le **pseudo** — via `set_username`, qui valide le format et l'unicité ;
- l'**e-mail** — un lien de confirmation part vers la nouvelle adresse, le changement
  n'est effectif qu'une fois ce lien cliqué ;
- le **mot de passe** — le mot de passe actuel est redemandé et revérifié : une session
  ouverte ne suffit pas à le changer.

## Configuration Supabase à faire une fois

1. **Authentication → URL Configuration**
   - *Site URL* : l'adresse publique du jeu (par exemple `https://thib9507.github.io/puissance4/`)
   - *Redirect URLs* : la même, plus `http://localhost:4173` pour le développement

   Sans ça, les liens de réinitialisation renvoient vers l'adresse par défaut
   (`localhost:3000`) au lieu de l'application.

2. **SMTP** — le serveur de mail intégré à Supabase est réservé aux tests : il plafonne
   à quelques e-mails par heure et renvoie alors `over_email_send_rate_limit`. Tant qu'un
   SMTP personnalisé (Resend, Brevo, Postmark…) n'est pas configuré dans
   *Project Settings → Authentication → SMTP Settings*, la réinitialisation de mot de
   passe et le changement d'e-mail ne partiront pas de façon fiable.

3. Optionnel : *Authentication → Policies* → activer **Leaked password protection**
   (vérification des mots de passe compromis via HaveIBeenPwned).

## Structure

```
index.html                     écrans (connexion, lobby, partie, stats, historique)
styles.css                     thème sombre, plateau, animations
src/config.js                  URL + clé publiable Supabase
src/api.js                     client Supabase, appels RPC, temps réel
src/board.js                   rendu du plateau + animation de chute
src/ai.js                      adversaire artificiel (minimax alpha-bêta)
src/app.js                     état de l'application et enchaînement des écrans
supabase/config.toml           configuration du projet (CLI Supabase)
supabase/migrations/           schéma SQL, une migration par fichier
supabase/functions/signin/     edge function de connexion par pseudo
supabase/functions/recover/    edge function « mot de passe oublié »
```

## Faire évoluer la base

Le dépôt fait autorité : le schéma et les edge functions se déploient depuis les
fichiers, jamais à la main dans le tableau de bord. Les sept migrations présentes
correspondent exactement au SQL appliqué sur le projet — même horodatage, même
contenu — de sorte qu'un `db push` sur le projet existant n'a rien à rejouer,
tandis qu'un projet vierge est reconstruit à l'identique en les rejouant dans
l'ordre.

La CLI n'a pas besoin d'être installée, `npx` suffit. Une seule fois :

```bash
npx supabase login
```

```bash
npx supabase link --project-ref czsdwhxlaowuwhhlytja
```

Ensuite, pour chaque changement de schéma :

```bash
npx supabase migration new nom_du_changement
```

On écrit le SQL dans le fichier créé, puis on applique :

```bash
npx supabase db push
```

Pour les edge functions (le `verify_jwt = false` des deux fonctions publiques est
porté par `config.toml`, il n'y a rien à préciser en ligne de commande) :

```bash
npx supabase functions deploy signin recover
```

Et pour vérifier à tout moment que le dépôt et le projet ne divergent pas :

```bash
npx supabase migration list --linked
```

Les colonnes *Local* et *Remote* doivent afficher les mêmes versions. Un écart
signifie qu'une modification a été faite hors du dépôt — `npx supabase db pull`
la rapatrie alors dans une nouvelle migration.

## Modèle de données

| Table | Rôle |
|---|---|
| `profiles` | pseudo lié à `auth.users` (créé automatiquement à l'inscription) |
| `games` | une partie : code, joueurs, couleurs, plateau, tour, résultat |
| `moves` | un coup par ligne (numéro, colonne, ligne, couleur) |

Le plateau est stocké dans une chaîne de 42 caractères, index = `ligne * 7 + colonne`,
ligne 0 = bas de la grille (`.` vide, `y` jaune, `r` rouge).

### Sécurité

Le client **ne peut pas écrire** dans `games` ni `moves` : il n'existe aucune policy
`insert`/`update`. Tout passe par des fonctions `SECURITY DEFINER` qui valident le coup
côté serveur (tour du joueur, colonne libre, détection d'alignement) :

`create_game()` · `create_solo_game(niveau)` · `join_game(code)` · `play_move(game, colonne)` ·
`timeout_move(game)` · `forfeit_game(game)` · `request_rematch(game)` · `accept_rematch(game)` ·
`decline_rematch(game)`

`apply_move` (pose du jeton, détection d'alignement) et `settle_elo` sont internes :
leurs droits d'exécution sont retirés à `anon` comme à `authenticated`, elles ne sont
appelables que par les fonctions ci-dessus.

En lecture, la RLS limite chaque joueur aux parties dont il est l'hôte ou l'invité.

### Statistiques

La vue `player_games` produit une ligne par joueur et par partie terminée ; les RPC
suivantes s'appuient dessus :

- `stats_overview()` — parties, victoires/défaites/nuls, taux de victoire, ratio V/D,
  série en cours, meilleure série, coups par partie, victoire la plus rapide
- `stats_by_color()` — taux de victoire en jaune et en rouge
- `stats_by_opponent()` — face à face : ratio victoire/défaite par adversaire
- `stats_vs_ai()` — résultats par niveau de l'ordinateur
- `leaderboard(limit)` — classement Elo de tous les joueurs
- `game_history(limit, offset)` — historique détaillé

Les parties solo sont exclues des statistiques classées (`mode = 'duel'`) mais
apparaissent dans l'historique et dans le tableau « Contre l'ordinateur ».

Pour ajouter une statistique : créer une fonction SQL dans une nouvelle migration, puis
l'afficher dans `loadStats()` (`src/app.js`).

## Temps réel

Chaque partie ouverte est suivie par un abonnement `postgres_changes` sur sa ligne de
`games`, doublé d'un rafraîchissement toutes les 5 s en cas de coupure du websocket.
