# Puissance 4

Jeu de puissance 4 en ligne : on défie quelqu'un en lui envoyant un **code à 6 caractères**
(ou un lien). Compte utilisateur, historique des parties et statistiques détaillées.

- **Les jaunes commencent toujours**, mais la couleur de chaque joueur est **tirée au sort**
  au moment où l'adversaire rejoint la partie.
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
src/app.js                     état de l'application et enchaînement des écrans
supabase/migrations/           schéma SQL (déjà appliqué sur le projet)
supabase/functions/signin/     edge function de connexion par pseudo
supabase/functions/recover/    edge function « mot de passe oublié »
```

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

`create_game()` · `join_game(code)` · `play_move(game, colonne)` · `forfeit_game(game)` · `rematch(game)`

En lecture, la RLS limite chaque joueur aux parties dont il est l'hôte ou l'invité.

### Statistiques

La vue `player_games` produit une ligne par joueur et par partie terminée ; les RPC
suivantes s'appuient dessus :

- `stats_overview()` — parties, victoires/défaites/nuls, taux de victoire, ratio V/D,
  série en cours, meilleure série, coups par partie, victoire la plus rapide
- `stats_by_color()` — taux de victoire en jaune et en rouge
- `stats_by_opponent()` — face à face : ratio victoire/défaite par adversaire
- `game_history(limit, offset)` — historique détaillé

Pour ajouter une statistique : créer une fonction SQL dans une nouvelle migration, puis
l'afficher dans `loadStats()` (`src/app.js`).

## Temps réel

Chaque partie ouverte est suivie par un abonnement `postgres_changes` sur sa ligne de
`games`, doublé d'un rafraîchissement toutes les 5 s en cas de coupure du websocket.
