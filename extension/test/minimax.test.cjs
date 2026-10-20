const assert = require("node:assert/strict")
const { test, before, after } = require("node:test")
const { build } = require("esbuild")
const { resolve } = require("node:path")
const Module = require("node:module")

// Replace extension host state, not the request handler, converter, or SDK transport.
const axios = require("axios")
const originalAdapter = axios.defaults.adapter
axios.defaults.adapter = async (config) => {
	assert.match(config.url, /^https:\/\/openrouter\.ai\/api\/v1\/generation\?id=/)
	return { data: { data: { total_cost: 0 } }, status: 200, statusText: "OK", headers: {}, config }
}
const originalLoad = Module._load
const state = { apiConfig: { providerId: "minimax" } }
let providerSettings = { providerId: "minimax", apiKey: "offline-fixture" }
Module._load = function (id, ...args) {
	if (id === "test:global-state") return { GlobalStateManager: { getInstance: () => ({ getGlobalState: (key) => state[key] }) } }
	if (id === "test:secret-state") return { SecretStateManager: { getInstance: () => ({ getSecretState: async () => JSON.stringify([providerSettings]) }) } }
	if (id === "test:kodu") return { KoduHandler: class {} }
	if (id === "vscode") return {}
	return originalLoad.call(this, id, ...args)
}
let CustomApiHandler, minimaxConfig, minimaxLegacyModels, MINIMAX_ENDPOINTS, getSelectableModels, getCurrentApiSettings, getCurrentModelInfo, OpenRouterModelCache
before(async () => {
const result = await build({
	stdin: {
		contents: `export * from './src/api/providers/custom-provider'; export * from './src/api/providers/config/minimax'; export * from './src/api/providers/config/model-choices'; export { getCurrentApiSettings, getCurrentModelInfo } from './src/router/routes/provider-router'; export { OpenRouterModelCache } from './src/api/providers/config/openrouter-cache';`,
		resolveDir: resolve(__dirname, ".."),
	},
	bundle: true,
	write: false,
	platform: "node",
	format: "cjs",
	packages: "external",
	plugins: [{ name: "extension-host-fixtures", setup(builder) {
		builder.onResolve({ filter: /global-state-manager$/ }, () => ({ path: "test:global-state", external: true }))
		builder.onResolve({ filter: /secret-state-manager$/ }, () => ({ path: "test:secret-state", external: true }))
		builder.onResolve({ filter: /^\.\/providers\/kodu$/ }, () => ({ path: "test:kodu", external: true }))
	} }],
})
const compiled = new Module(__filename, module)
compiled.filename = __filename
compiled.paths = module.paths
compiled._compile(result.outputFiles[0].text, __filename)
;({ CustomApiHandler, minimaxConfig, minimaxLegacyModels, MINIMAX_ENDPOINTS, getSelectableModels, getCurrentApiSettings, getCurrentModelInfo, OpenRouterModelCache } = compiled.exports)
})
const originalFetch = globalThis.fetch
after(() => { Module._load = originalLoad; globalThis.fetch = originalFetch; axios.defaults.adapter = originalAdapter })

test("ordinary choices are Flash-first while legacy/custom/media metadata remains available", () => {
	assert.deepEqual(minimaxConfig.models.map((m) => m.id), ["MiniMax-M3.1-Flash", "MiniMax-M3"])
	assert.equal(minimaxConfig.models[0].maxTokens, 524288)
	assert.equal(minimaxConfig.models[0].cacheWritesPrice, undefined)
	const gateway = (id) => ({ ...minimaxConfig.models[0], id, provider: "openrouter", contextWindow: 12345, inputPrice: 7 })
	const other = { ...minimaxConfig.models[0], id: "other/model", provider: "openrouter" }
	const custom = { ...minimaxLegacyModels[0], provider: "openai-compatible" }
	const media = gateway("minimax/video-01")
	const m3 = gateway("minimax/minimax-m3")
	const flash = gateway("minimax/minimax-m3.1-flash:free")
	const input = [other, m3, gateway("minimax/minimax-m2.7"), custom, flash, media, ...minimaxConfig.models, ...minimaxLegacyModels]
	const before = JSON.stringify(input)
	assert.deepEqual(getSelectableModels(input), [other, flash, custom, m3, media, ...minimaxConfig.models])
	assert.equal(JSON.stringify(input), before)
	assert.equal(getSelectableModels(input)[1], flash)
})

test("missing MiniMax selection defaults to Flash without resetting saved ids", async () => {
	state.apiConfig = { providerId: "minimax" }
	assert.equal((await getCurrentModelInfo()).model.id, "MiniMax-M3.1-Flash")
	for (const modelId of ["MiniMax-M3", "MiniMax-M2.7"]) {
		state.apiConfig = { providerId: "minimax", modelId }
		assert.equal((await getCurrentModelInfo()).model.id, modelId)
		assert.equal(state.apiConfig.modelId, modelId)
	}
	state.apiConfig = { providerId: "minimax", modelId: "unknown-explicit-id" }
	await assert.rejects(getCurrentModelInfo(), /Model not found/)
})

test("real stream handler serializes default, saved and custom requests on regional transports", async () => {
	const history = [
		{ role: "user", content: "Earlier request" },
		{ role: "assistant", content: "Earlier response" },
		{ role: "user", content: [
			{ type: "text", text: "Describe this image" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
		] },
	]
	const before = JSON.stringify(history)
	for (const endpoint of [{ baseUrl: "https://api.minimax.io/v1", apiFormat: "openai", useDefault: true }, ...MINIMAX_ENDPOINTS, { baseUrl: "https://custom.invalid/v1", apiFormat: "openai" }]) {
		for (const selectedId of [undefined, "MiniMax-M3", "MiniMax-M2.7"]) {
			providerSettings = { providerId: "minimax", apiKey: "offline-fixture", baseUrl: endpoint.useDefault ? undefined : endpoint.baseUrl + "/" }
			state.apiConfig = { providerId: "minimax", modelId: selectedId }
			const options = await getCurrentApiSettings()
			const handler = new CustomApiHandler(options)
			let captured
			globalThis.fetch = async (url, init) => {
				captured = { url: String(url), body: JSON.parse(init.body) }
				return new Response(endpoint.apiFormat === "anthropic" ? "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n" : "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
			}
			for await (const event of handler.createMessageStream({ messages: history, systemPrompt: ["System instruction"], modelId: handler.getModel().id, abortSignal: null })) {
				assert.notEqual(event.code, -1, JSON.stringify(event))
			}
			assert.ok(captured)
			assert.equal(captured.body.model, selectedId || "MiniMax-M3.1-Flash")
			assert.equal(captured.body.stream, true)
			assert.equal(captured.url, endpoint.baseUrl + (endpoint.apiFormat === "anthropic" ? "/v1/messages" : "/chat/completions"))
			assert.equal(captured.body.thinking, undefined)
			assert.equal(captured.body.reasoning_effort, undefined)
			assert.equal(captured.body.output_config, undefined)
			assert.equal(captured.body.service_tier, undefined)
			assert.equal(captured.body.reasoning_split, undefined)
			assert.match(JSON.stringify(captured.body.messages), /Earlier request/)
			assert.match(JSON.stringify(captured.body.messages), /Earlier response/)
			assert.match(JSON.stringify(captured.body.messages), /iVBORw0KGgo=/)
			assert.equal(JSON.stringify(history), before)
		}
	}
	providerSettings = { providerId: "openai-compatible", modelId: "MiniMax-custom-saved", apiKey: "offline-fixture", baseUrl: "https://custom.invalid/v1", supportImages: true, inputLimit: "1000000", outputLimit: "4096", inputTokensPrice: 0, outputTokensPrice: 0 }
	state.apiConfig = { providerId: "openai-compatible", modelId: providerSettings.modelId }
	const handler = new CustomApiHandler(await getCurrentApiSettings())
	let body
	globalThis.fetch = async (_url, init) => {
		body = JSON.parse(init.body)
		return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
	}
	for await (const event of handler.createMessageStream({ messages: history, systemPrompt: [], modelId: handler.getModel().id, abortSignal: null })) assert.notEqual(event.code, -1)
	assert.equal(body.model, "MiniMax-custom-saved")
})

test("gateway requests retain current and explicit legacy model ids", async () => {
	const cache = OpenRouterModelCache.getInstance({})
	cache.cache = ["minimax/minimax-m3.1-flash:free", "minimax/minimax-m3", "minimax/minimax-m2.7"].map((id) => ({
		...minimaxConfig.models[0], id, provider: "openrouter", contextWindow: 12345,
	}))
	cache.lastFetched = Date.now()
	providerSettings = { providerId: "openrouter", apiKey: "offline-fixture" }
	for (const model of cache.cache) {
		state.apiConfig = { providerId: "openrouter", modelId: model.id }
		const handler = new CustomApiHandler(await getCurrentApiSettings())
		assert.equal(handler.getModel().info.contextWindow, 12345)
		let captured
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), body: JSON.parse(init.body) }
			return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
		}
		for await (const event of handler.createMessageStream({ messages: [{ role: "user", content: "Hello" }], systemPrompt: [], modelId: handler.getModel().id, abortSignal: null })) assert.notEqual(event.code, -1)
		assert.equal(captured.body.model, model.id)
		assert.equal(captured.url, "https://openrouter.ai/api/v1/chat/completions")
	}
})
