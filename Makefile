.PHONY: install dev build test lint typecheck format docker

install:
	npm ci

dev:
	npm run dev

build:
	npm run build

test:
	npm run test:coverage

lint:
	npm run lint && npm run format:check

typecheck:
	npm run typecheck

format:
	npm run format

docker:
	docker compose up --build
