import { useEffect, useRef, useState } from 'react'
import EmailEditor, { type EditorRef, type EmailEditorProps } from 'react-email-editor'
import { describeAgent, getAgentDesign, loadAgentDesign } from './engine/unlayerAgent'
import { approveEdit, prepareParagraphEdit, type PreparedParagraphEdit } from './engine/proposals'
import { createPolicyGate, DEFAULT_POLICY_CONFIG } from './engine/policies'
import { checkAiStatus, requestAiGeneration, type AiMode } from './ai/aiProvider'
import { finalizeAiGeneration } from './ai/aiProposals'
import type { AgentLoadDesignResult } from './engine/types'
import { ChangeInspector, NativeResultPanel } from './shared/ChangeInspector'
import { InspectorErrorBoundary } from './shared/ErrorBoundary'

function App() {
  const editorRef = useRef<EditorRef>(null)
  const [prompt, setPrompt] = useState('')
  const [showDeveloper, setShowDeveloper] = useState(false)
  const [design, setDesign] = useState<unknown>(null)
  const [status, setStatus] = useState('No design captured yet.')
  const [agentStatus, setAgentStatus] = useState('Waiting for editor...')
  const [proposalStatus, setProposalStatus] = useState('No change prepared yet.')
  const [isApplying, setIsApplying] = useState(false)
  const approvalInProgress = useRef(false)
  const [proposal, setProposal] = useState<PreparedParagraphEdit | null>(null)
  const [rejection, setRejection] = useState<AgentLoadDesignResult | null>(null)
  const [lastApplied, setLastApplied] = useState<AgentLoadDesignResult | null>(null)
  const [aiInstruction, setAiInstruction] = useState('')
  const [aiMode, setAiMode] = useState<AiMode>('edit')
  const [aiStatus, setAiStatus] = useState<string | null>(null)
  const [aiRunning, setAiRunning] = useState(false)
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null)
  const aiAbort = useRef<AbortController | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const configured = await checkAiStatus()
      if (!cancelled) setAiAvailable(configured)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const onReady: EmailEditorProps['onReady'] = (editor) => {
    void checkAgentConnection()
    let saveTimer: ReturnType<typeof setTimeout> | undefined
    let listening = false

    const startAutosave = () => {
      if (listening) return
      listening = true
      editor.addEventListener('design:updated', () => {
        if (saveTimer) clearTimeout(saveTimer)
        setStatus('Saving changes...')
        saveTimer = setTimeout(() => {
          editor.saveDesign((result) => {
            try {
              localStorage.setItem('unlayer-agent-lab:design:v1', JSON.stringify(result))
              setStatus('All changes saved automatically.')
            } catch {
              setStatus('Autosave failed. Your latest changes may not be stored.')
            }
          })
        }, 1000)
      })
    }

    try {
      const stored = localStorage.getItem('unlayer-agent-lab:design:v1')
      if (!stored) {
        startAutosave()
        setStatus('Autosave ready.')
        return
      }
      const saved = JSON.parse(stored) as Parameters<typeof editor.loadDesign>[0]
      if (!saved || typeof saved !== 'object' || !('body' in saved)) {
        setStatus('Invalid saved design. Autosave paused.')
        return
      }
      editor.addEventListener('design:loaded', () => {
        startAutosave()
        setStatus('Saved design restored. Autosave ready.')
      })
      editor.loadDesign(saved)
      setStatus('Restoring saved design...')
    } catch {
      setStatus('Restoration failed. Autosave paused to protect saved data.')
    }
  }

  const checkAgentConnection = async () => {
    setAgentStatus('Checking agent connection...')
    try {
      const details = await describeAgent()
      const count = details.editors?.length ?? 0
      setAgentStatus(count > 0 ? 'Connected to ' + count + ' agent-enabled editor(s).' : 'No agent-enabled editors found.')
    } catch (error) {
      setAgentStatus(error instanceof Error ? error.message : 'Agent connection failed.')
    }
  }

  const prepareDemoEdit = async () => {
    setProposal(null)
    setRejection(null)
    setLastApplied(null)
    setProposalStatus('Preparing change...')

    try {
      const original = await getAgentDesign()
      const prepared = prepareParagraphEdit(original, prompt)

      setProposal(prepared)

      setProposalStatus('Proposal ready. The canvas has not been changed.')
    } catch (error) {
      setProposalStatus(
        error instanceof Error ? error.message : 'Could not prepare change.'
      )
    }
  }
  const approveProposal = async () => {
    if (!proposal || approvalInProgress.current) return

    approvalInProgress.current = true
    setIsApplying(true)
    setProposalStatus('Checking the current design...')

    try {
      const outcome = await approveEdit(
        {
          getDesign: getAgentDesign,
          loadDesign: (design) => loadAgentDesign(design),
        },
        proposal,
        {
          // The synchronous guard above already covers re-entrancy in this
          // call path (the ref is set before we reach the runner); the
          // runner re-checks the flag for other/future callers.
          alreadyApplying: false,
          backup: (baseDesign) => {
            localStorage.setItem(
              'unlayer-agent-lab:design:pre-approved-edit:v1',
              baseDesign
            )
          },
          policyGate: createPolicyGate(DEFAULT_POLICY_CONFIG, proposal.baseDesign),
          onApplying: () => {
            setProposalStatus('Applying approved change...')
          },
        }
      )

      if (outcome.status === 'skipped') {
        return
      }

      if (outcome.status === 'stale') {
        setProposal(null)
        setRejection(null)
        setProposalStatus(
          'The design changed after this proposal was prepared. Prepare a new proposal.'
        )
        return
      }

      if (outcome.status === 'blocked') {
        setProposal({ ...proposal, policies: outcome.policies, policyBlocked: true })
        setProposalStatus(
          'Blocked by application policy. Review the failing checks above.'
        )
        return
      }

      if (outcome.status === 'rejected') {
        setRejection(outcome.native)
        throw new Error(outcome.message)
      }

      setRejection(null)
      setLastApplied(outcome.native)
      setProposal(null)
      setProposalStatus('Approved change applied successfully.')
    } catch (error) {
      setProposalStatus(
        error instanceof Error ? error.message : 'Approval failed.'
      )
    } finally {
      approvalInProgress.current = false
      setIsApplying(false)
    }
  }
  const generateAi = async () => {
    if (aiRunning || approvalInProgress.current) return
    setProposal(null)
    setRejection(null)
    setLastApplied(null)
    setAiStatus('Reading the current design...')

    let base: unknown
    try {
      base = await getAgentDesign()
    } catch (error) {
      setAiStatus(error instanceof Error ? error.message : 'Could not read the current design.')
      return
    }
    const baseSnapshot = JSON.stringify(base)
    const controller = new AbortController()
    aiAbort.current = controller
    setAiRunning(true)
    setAiStatus(aiMode === 'create' ? 'Generating a new design with AI...' : 'Asking AI to edit the design...')

    try {
      const result = await requestAiGeneration(
        { instruction: aiInstruction, mode: aiMode, baseDesign: base },
        { signal: controller.signal },
      )
      const live = await getAgentDesign()
      const outcome = finalizeAiGeneration({
        result,
        baseSnapshot,
        liveDesign: live,
        instruction: aiInstruction,
        mode: aiMode,
      })
      switch (outcome.status) {
        case 'ready':
          setProposal(outcome.proposal)
          setAiStatus('AI proposal ready. The canvas has not been changed.')
          break
        case 'stale':
          setAiStatus('The design changed while AI was generating. Review the canvas and try again.')
          break
        case 'no-change':
          setAiStatus('AI reported no changes for that instruction.')
          break
        case 'provider-error':
          setAiStatus(outcome.message)
          break
      }
    } catch (error) {
      if (controller.signal.aborted) {
        setAiStatus('AI request cancelled.')
      } else {
        setAiStatus(error instanceof Error ? error.message : 'AI request failed.')
      }
    } finally {
      aiAbort.current = null
      setAiRunning(false)
    }
  }

  const cancelAi = () => {
    aiAbort.current?.abort()
  }

  const captureDesign = () => {
    const editor = editorRef.current?.editor
    if (!editor) {
      setStatus('Editor is not ready yet.')
      return
    }
    editor.saveDesign((result) => {
      window.localStorage.setItem('unlayer-agent-lab:design:v1', JSON.stringify(result))
      setDesign(result)
      setStatus('Design saved in this browser.')
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
        <p role='status'>{agentStatus}</p>
        <label htmlFor='replacement-text'>Replacement paragraph text (manual test)</label>
        <textarea id='replacement-text' rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder='Enter replacement text for the first paragraph...' />
        <div>
          <button type='button' onClick={() => void prepareDemoEdit()}>
            Prepare Text Edit
          </button>
        </div>
        <p role='status'>{proposalStatus}</p>
        {proposal && (
          <InspectorErrorBoundary>
            <ChangeInspector
              proposal={proposal}
              isApplying={isApplying}
              rejection={rejection}
              onApprove={() => void approveProposal()}
              onDiscard={() => {
                setProposal(null)
                setRejection(null)
                setProposalStatus('Proposal discarded.')
              }}
            />
          </InspectorErrorBoundary>
        )}
        {lastApplied && <NativeResultPanel title="Last applied change" result={lastApplied} />}
        <div>
          <h3>Generate with AI</h3>
          {aiAvailable === false && (
            <p>AI is not configured. Start the local AI server with an Unlayer API key — see docs/AI_STUDIO.md. Manual editing still works.</p>
          )}
          <div role='radiogroup' aria-label='AI mode'>
            <label>
              <input type='radio' name='ai-mode' checked={aiMode === 'edit'} onChange={() => setAiMode('edit')} />
              {' '}Edit current design
            </label>
            <label>
              <input type='radio' name='ai-mode' checked={aiMode === 'create'} onChange={() => setAiMode('create')} />
              {' '}Create new design
            </label>
          </div>
          <label htmlFor='ai-instruction'>AI instruction</label>
          <textarea id='ai-instruction' rows={3} value={aiInstruction} onChange={(event) => setAiInstruction(event.target.value)} placeholder='Describe the email design... e.g. "A spring sale announcement with a 20% off button"' />
          <div>
            <button type='button' onClick={() => void generateAi()} disabled={aiRunning || aiAvailable === false}>
              {aiRunning ? 'Generating...' : 'Generate with AI'}
            </button>
            {aiRunning && (
              <button type='button' onClick={cancelAi}>
                Cancel
              </button>
            )}
          </div>
          {aiStatus && <p role='status'>{aiStatus}</p>}
        </div>
      </section>

      <section aria-label='Visual editor'>
        <h2>Visual Editor</h2>
        <p role='status'>{status}</p>
        <EmailEditor ref={editorRef} onReady={onReady} options={{ version: 'latest' }} minHeight='650px' />
      </section>

      {showDeveloper && (
        <section aria-label='Developer tools'>
          <h2>Developer Tools</h2>
          <button type='button' onClick={captureDesign}>Save Design Locally</button>
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





