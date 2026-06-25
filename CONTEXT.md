import { theme } from '../lib/theme'

export default function Fechamentos() {
  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Fechamentos</h1>
      <p style={{ color: theme.sub, fontSize: 13 }}>
        Próxima onda: importação do razão, balancete e conciliação por competência.
        A UX completa está no protótipo de referência (pasta <code>/prototipo</code>).
      </p>
    </div>
  )
}
