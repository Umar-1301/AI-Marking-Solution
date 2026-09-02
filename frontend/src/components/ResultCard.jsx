function descriptorsForBreakdownItem(scheme, item) {
  const objectives = scheme?.assessment_objectives
  if (!Array.isArray(objectives)) return []

  const objective = objectives.find(ao => ao?.ao === item.section)
  const bands = objective?.bands
  if (!Array.isArray(bands)) return []

  const band = bands.find(candidate => candidate?.band === item.awardedBand)
  return Array.isArray(band?.descriptors) ? band.descriptors : []
}

function ResultCard({ result, scheme }) {
  const percentage = result.percentage ?? Math.round((result.score / result.maxScore) * 100)

  const getGradeColour = (pct) => {
    if (pct >= 70) return '#10b981'
    if (pct >= 50) return '#f59e0b'
    return '#ef4444'
  }

  const getGradeLabel = (pct) => {
    if (pct >= 70) return 'Pass'
    if (pct >= 50) return 'Near pass'
    return 'Needs work'
  }

  const getBadgeClass = (pct) => {
    if (pct >= 70) return 'result-grade-badge grade-high'
    if (pct >= 50) return 'result-grade-badge grade-mid'
    return 'result-grade-badge grade-low'
  }

  const colour = getGradeColour(percentage)

  return (
    <div className="result-card">
      <div className="result-header">
        <div className="result-title-group">
          <span className="result-label">Marking Result</span>
          <span className="result-title">Assessment Complete</span>
        </div>
        <span className={getBadgeClass(percentage)}>{getGradeLabel(percentage)}</span>
      </div>

      <div className="result-score-section">
        <div className="score-row">
          <span className="score-number" style={{ color: colour }}>{result.score}</span>
          <span className="score-separator">/</span>
          <span className="score-max">{result.maxScore}</span>
        </div>

        <div className="progress-track">
          <div
            className="progress-fill"
            style={{
              width: `${percentage}%`,
              background: `linear-gradient(90deg, ${colour}cc, ${colour})`,
            }}
          />
        </div>

        <div className="progress-meta">
          <span className="progress-pct">{percentage}% achieved</span>
          <span className="progress-label">{result.score} marks out of {result.maxScore}</span>
        </div>
      </div>

      {result.breakdown && result.breakdown.length > 0 && (
        <div className="result-breakdown">
          <div className="section-label">Breakdown</div>
          {result.breakdown.map((item, index) => {
            const itemPct = Math.round((item.marks / item.maxMarks) * 100)
            const descriptors = descriptorsForBreakdownItem(scheme, item)
            return (
              <div key={index} className="breakdown-item">
                <div className="breakdown-criterion">
                  <span className="breakdown-name">{item.section}</span>
                  {descriptors.length > 0 && (
                    <ul className="breakdown-descriptors">
                      {descriptors.map((descriptor, descriptorIndex) => {
                        const isStructured = descriptor && typeof descriptor === 'object'
                        const text = isStructured ? descriptor.text : descriptor
                        const id = isStructured ? descriptor.id : null

                        return (
                          <li key={id ?? descriptorIndex} className="breakdown-descriptor">
                            {id && <code className="breakdown-descriptor-id">{id}</code>}
                            <span>{text}</span>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
                <div className="breakdown-bar-track">
                  <div
                    className="breakdown-bar-fill"
                    style={{ width: `${itemPct}%` }}
                  />
                </div>
                <span className="breakdown-score">{item.marks} / {item.maxMarks}</span>
              </div>
            )
          })}
        </div>
      )}

      {result.feedback && (
        <div className="result-feedback">
          <div className="section-label">Feedback</div>
          <p className="feedback-text">{result.feedback}</p>
        </div>
      )}
    </div>
  )
}

export default ResultCard
