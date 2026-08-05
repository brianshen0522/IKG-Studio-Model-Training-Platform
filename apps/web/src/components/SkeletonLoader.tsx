interface SkeletonLoaderProps {
  rows?: number;
  cols?: number;
  variant?: 'table' | 'list' | 'card';
}

export function SkeletonLoader({ rows = 5, cols = 4, variant = 'table' }: SkeletonLoaderProps) {
  if (variant === 'table') {
    return (
      <div className="table-wrap">
        <table style={{ width: '100%' }}>
          <tbody>
            {[...Array(rows)].map((_, i) => (
              <tr key={i}>
                {[...Array(cols)].map((_, j) => (
                  <td key={j} style={{ padding: '0.7rem 0.9rem' }}>
                    <div
                      className="skeleton"
                      style={{
                        height: '16px',
                        borderRadius: '4px',
                        background: 'linear-gradient(90deg, var(--surface-muted) 25%, var(--surface) 50%, var(--surface-muted) 75%)',
                        backgroundSize: '200% 100%',
                        animation: 'shimmer 2s infinite'
                      }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (variant === 'list') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {[...Array(rows)].map((_, i) => (
          <div
            key={i}
            style={{
              height: '40px',
              borderRadius: '4px',
              background: 'linear-gradient(90deg, var(--surface-muted) 25%, var(--surface) 50%, var(--surface-muted) 75%)',
              backgroundSize: '200% 100%',
              animation: 'shimmer 2s infinite'
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '12px' }}>
      {[...Array(rows)].map((_, i) => (
        <div key={i} style={{
          borderRadius: '8px',
          padding: '16px',
          background: 'linear-gradient(90deg, var(--surface-muted) 25%, var(--surface) 50%, var(--surface-muted) 75%)',
          backgroundSize: '200% 100%',
          animation: 'shimmer 2s infinite',
          height: '200px'
        }} />
      ))}
    </div>
  );
}
