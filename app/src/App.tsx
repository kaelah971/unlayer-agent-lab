import { useRef, useState } from 'react'
import EmailEditor, { type EditorRef } from 'react-email-editor'

function App() {
  const editorRef = useRef<EditorRef>(null)
  const [prompt, setPrompt] = useState('')
  const [showDeveloper, setShowDeveloper] = useState(false)
  const [design, setDesign] = useState<unknown>(null)
  const [status, setStatus] = useState('No design captured yet.')

  const captureDesign = () => {
    const editor = editorRef.current?.editor
    if (!editor) {
      setStatus('Editor is not ready yet.')
      return
    }
    editor.saveDesign((result) => {
      setDesign(result)
      setStatus('Design captured successfully.')
    })
  }

  return (
    <main>
      <header>
        <h1>Unlayer Agent Lab</h1>
        <button type='button' aria-pressed={showDeveloper} onClick={() => setShowDeveloper((value) => !value)}>
          {showDeveloper ? 'Hide Developer Mode' : 'Developer Mode'}
        </button>
      </header>
      <p>Human creativity meets agent-powered editing.</p>

      <section aria-label='AI instructions'>
        <h2>What would you like to create?</h2>
        <textarea rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder='Describe the email you want to create...' />
        <div><button type='button' disabled>Generate with AI (coming soon)</button></div>
        <p>AI generation is not connected yet. Manual editing is available below.</p>
      </section>

      <section aria-label='Visual editor'>
        <h2>Visual Editor</h2>
        <EmailEditor ref={editorRef} minHeight='650px' />
      </section>

      {showDeveloper && (
        <section aria-label='Developer tools'>
          <h2>Developer Tools</h2>
          <button type='button' onClick={captureDesign}>Capture Design JSON</button>
          <p role='status'>{status}</p>
          {design !== null && (
            <pre style={{ maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {JSON.stringify(design, null, 2)}
            </pre>
          )}
        </section>
      )}
    </main>
  )
}

export default App
