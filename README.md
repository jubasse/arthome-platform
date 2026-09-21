# arthome-platform

Les **sept microservices NestJS** et l'infrastructure : PostgreSQL (une base par service), Kafka avec Kafka Connect et Debezium, Redis, OpenSearch, MinIO.

`identity` · `catalog` · `ticketing` · `streaming` · `chat` · `payouts` · `notifications`

## État

**Pas encore commencé.** Palier 2 — le socle distribué. Deux services d'abord (`identity`, `catalog`), mais le chemin événementiel de bout en bout : outbox dans la transaction, schéma Protobuf versionné, CDC vers l'index, `traceparent` propagé.

## Où est la conception

L'architecture, les contrats d'interface, les décisions et leurs raisons vivent dans
**[arthome-core](https://github.com/jubasse/arthome-core)** :

- `architecture/` — carte des contextes, modèle de données, catalogue d'événements, ADR
- `openapi/` — les contrats des deux BFF
- `proto/` — les schémas d'événements Kafka
- `DECISIONS.md` — le journal des arbitrages
- `architecture/critical-rules.md` — **à relire à chaque session**, dix-neuf lignes

## Arthome

Plateforme de diffusion en direct de spectacle vivant : billetterie, direct, tchat modéré,
rediffusions, boutique, versements aux artistes. Deux produits — un storefront public et un studio
professionnel — sur cinq surfaces, servis par sept microservices.
