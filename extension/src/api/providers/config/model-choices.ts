import { ModelInfo } from "../types"
import { minimaxConfig } from "./minimax"

const currentMiniMaxIds: Record<string, string[]> = {
	minimax: minimaxConfig.models.map((model) => model.id),
	openrouter: ["minimax/minimax-m3.1-flash:free", "minimax/minimax-m3"],
}

const isMiniMaxTextModel = (model: ModelInfo) =>
	model.provider === "minimax" ||
	(model.provider === "openrouter" && /^minimax\/(?:minimax-(?:m\d|text-|01)|abab)/i.test(model.id))

// Only filter ordinary choices. Keep upstream metadata and the full catalog for saved requests.
export const getSelectableModels = (models: ModelInfo[]): ModelInfo[] => {
	const visible = models.filter(
		(model) => !isMiniMaxTextModel(model) || currentMiniMaxIds[model.provider]?.includes(model.id)
	)
	const ordered = Object.fromEntries(
		Object.entries(currentMiniMaxIds).map(([provider, ids]) => [
			provider,
			ids.flatMap((id) => visible.filter((model) => model.provider === provider && model.id === id)),
		])
	)
	return visible.map((model) => (isMiniMaxTextModel(model) ? ordered[model.provider].shift()! : model))
}
