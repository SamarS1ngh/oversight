.PHONY: install up down logs ps vapid
install: ; ./install.sh
up: ; docker compose up -d --build
down: ; docker compose down
logs: ; docker compose logs -f --tail=100
ps: ; docker compose ps
vapid: ## generate VAPID keys into .env (enables web push)
	@docker compose run --rm --no-deps --entrypoint "" backend bun run scripts/gen-vapid.ts | \
	  while IFS= read -r line; do \
	    key=$${line%%=*}; sed -i.bak "s|^$$key=.*|$$line|" .env && rm -f .env.bak; \
	  done; echo "VAPID keys written to .env — run 'make up' to apply."
