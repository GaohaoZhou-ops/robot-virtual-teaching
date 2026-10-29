export const MODEL_EDITOR_DISPLAY_QUALITIES = Object.freeze([
  { id: 'performance', label: '流畅', pointBudget: 80000, faceBudget: 180000 },
  { id: 'balanced', label: '均衡', pointBudget: 160000, faceBudget: 650000 },
  { id: 'detail', label: '精细', pointBudget: 600000, faceBudget: 2000000 },
  { id: 'full', label: '全量', pointBudget: Infinity, faceBudget: Infinity },
]);

export const resolveModelEditorDisplayQuality = (quality) => MODEL_EDITOR_DISPLAY_QUALITIES
  .find(({ id }) => id === quality) || MODEL_EDITOR_DISPLAY_QUALITIES[1];
