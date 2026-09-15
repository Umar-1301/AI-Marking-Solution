export function feedbackResult(row) {
  const final = row.finalResult?.status === 'complete' ? row.finalResult.result : null
  const evidenceResult = final ?? (
    row.aggregation?.status === 'complete' ? row.aggregation.result : null
  )
  return {
    result: final ?? row.result,
    evidenceResult,
    studentText: row.result.studentOcrText ?? '',
    actionableSteps: final ? [] : (row.result.actionableSteps ?? row.result.actionable_steps ?? []),
    finalUnavailable: Boolean(row.finalResult && !final),
  }
}
