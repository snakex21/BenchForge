import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Benchmark, Task } from '@/types'
import { SnapshotViewer, loadReadOnlyStores } from './SnapshotViewer'
import { createReadOnlyTransport, type ReadOnlyTransport, type SnapshotMeta } from './transport'
import { useBenchmarkStore } from '@/store/benchmarkStore'
import { useModelStore } from '@/store/modelStore'
import { useResultStore } from '@/store/resultStore'
import { useUIStore } from '@/store/uiStore'
import fixture from '../../../go-viewer/examples/synthetic.json'
const meta: SnapshotMeta = {version:'benchforge-readonly-snapshot-v1',read_only:true,label:'Synthetic demonstration',source_kind:'synthetic',evaluator_origin:'legacy-unversioned-fixture',snapshot_sha256:'test-sha',capabilities:['statistics.view']}
function api(): ReadOnlyTransport {
 return {getMeta:vi.fn(async()=>meta),getModels:vi.fn(async()=>fixture.models as Awaited<ReturnType<ReadOnlyTransport['getModels']>>),getBenchmarks:vi.fn(async()=>fixture.benchmarks as Benchmark[]),tasks:{get:vi.fn(async()=>fixture.tasks as Task[])},getResults:vi.fn(async()=>fixture.results),getRuns:vi.fn(async()=>fixture.runs)}
}
beforeEach(()=>{useUIStore.setState({language:'en'});useBenchmarkStore.setState({benchmarks:[],tasks:[]});useModelStore.setState({models:[]});useResultStore.setState({results:[],runs:[]})})
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
describe('read-only transport',()=>{
 it('uses only explicit GET routes and throws real API errors',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>meta}).mockResolvedValueOnce({ok:true,json:async()=>fixture.models}).mockResolvedValueOnce({ok:false,status:404,json:async()=>({error:'unsupported read-only capability'})})
  vi.stubGlobal('fetch',fetch);const transport=createReadOnlyTransport();expect((await transport.getMeta()).read_only).toBe(true);expect(await transport.getModels()).toHaveLength(2);await expect(transport.tasks.get({benchmarkId:99})).rejects.toThrow('unsupported read-only capability');expect(fetch.mock.calls.every(c=>c[1].method==='GET')).toBe(true)
 })
 it('rejects incompatible or writable backend metadata',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({...meta,read_only:false})})));await expect(createReadOnlyTransport().getMeta()).rejects.toThrow('Unsupported or writable')
 })
})
describe('read-only data and reused presentation',()=>{
 it('gates startup deletion and preserves stale legacy tasks',async()=>{
  const source={...api(),tasks:{...api().tasks,delete:vi.fn(async()=>{})}};await useBenchmarkStore.getState().loadFromDb({readOnly:true,source});expect(source.tasks.delete).not.toHaveBeenCalled();expect(useBenchmarkStore.getState().tasks).toHaveLength(2);expect(useBenchmarkStore.getState().tasks[0].name).toBe('Zadanie 1')
 })
 it('keeps legacy cleanup behavior outside explicitly read-only mode',async()=>{
  const source={...api(),tasks:{...api().tasks,delete:vi.fn(async()=>{})}};await useBenchmarkStore.getState().loadFromDb({source});expect(source.tasks.delete).toHaveBeenCalledWith({id:1})
 })
 it('loads all data through the bounded adapter without using Electron globals',async()=>{
  const transport=api();const before=JSON.stringify(fixture);await loadReadOnlyStores(transport);expect(useModelStore.getState().models).toHaveLength(2);expect(useResultStore.getState().results).toHaveLength(2);expect(JSON.stringify(fixture)).toBe(before);expect(window.db).toBeUndefined()
 })
 it('renders actual existing StatsView and preserved inventory with 58 languages',async()=>{
  render(<SnapshotViewer api={api()}/>);await waitFor(()=>expect(screen.getAllByText('Fixture Model A').length).toBeGreaterThan(0));expect(screen.getAllByText('Synthetic arithmetic').length).toBeGreaterThan(0);expect(screen.getByText(/Historical display only/)).toBeInTheDocument();expect(screen.getByLabelText('Language / Język').querySelectorAll('option')).toHaveLength(58)
  fireEvent.click(screen.getByRole('button',{name:'Snapshot inventory'}));expect(screen.getByText('Zadanie 1')).toBeInTheDocument();expect(screen.getByText('Actual task')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Language / Język'),{target:{value:'ar'}});await waitFor(()=>expect(document.documentElement.dir).toBe('rtl'))
 })
 it('shows backend failures rather than a fake empty success',async()=>{
  const transport=api();transport.getModels=vi.fn(async()=>{throw Error('snapshot missing')});render(<SnapshotViewer api={transport}/>);expect(await screen.findByRole('alert')).toHaveTextContent('snapshot missing');expect(screen.queryByRole('button',{name:'Snapshot inventory'})).not.toBeInTheDocument()
 })
})

it('preserves code-presence historical display evidence from response notes', async () => {
 const { getEffectiveScoreNorm } = await import('@/utils/scoring')
 const transport = api()
 const benchmark = {...fixture.benchmarks[0],pass_condition:JSON.stringify({mode:'code_presence',required:['function answer']}),tasks:[]} as Benchmark
 const result = {...fixture.results[0],score:'0',notes:'function answer() { return 4 }'}
 transport.getBenchmarks = vi.fn(async()=>[benchmark]);transport.tasks.get=vi.fn(async()=>[]);transport.getResults=vi.fn(async()=>[result])
 const before=getEffectiveScoreNorm(result,benchmark)
 await loadReadOnlyStores(transport)
 const after=getEffectiveScoreNorm(useResultStore.getState().results[0],useBenchmarkStore.getState().benchmarks[0])
 expect(before).toBe(1);expect(after).toBe(before)
})
