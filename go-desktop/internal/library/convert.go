package library

import (
	"fmt"
	"math"
	"regexp"
	"strings"
)

type benchSpec struct {
	Name           string
	Category       string
	SuiteName      string
	Description    string
	PromptTemplate string
	ScoreType      string // "" -> numeric
	Tasks          []map[string]any
}

func makeBenchmark(s benchSpec) map[string]any {
	scoreType := s.ScoreType
	if scoreType == "" {
		scoreType = "numeric"
	}
	tasks := s.Tasks
	if tasks == nil {
		tasks = []map[string]any{}
	}
	return map[string]any{
		"name":                 s.Name,
		"category":             s.Category,
		"suite_name":           s.SuiteName,
		"description":          s.Description,
		"prompt_template":      s.PromptTemplate,
		"score_type":           scoreType,
		"expected_answer":      nil,
		"pass_condition":       nil,
		"evaluation_checklist": []any{},
		"evaluation_rubric":    []any{},
		"attempts":             1,
		"output_type":          "text",
		"reference_image":      nil,
		"tasks":                tasks,
	}
}

type taskSpec struct {
	Name          string
	Prompt        string
	ScoreType     string // "" -> numeric
	PassCondition any    // string or nil
	Checklist     []string
	Rubric        []map[string]any
	OutputType    string // "" -> text
}

func taskBase(t taskSpec) map[string]any {
	scoreType := t.ScoreType
	if scoreType == "" {
		scoreType = "numeric"
	}
	outputType := t.OutputType
	if outputType == "" {
		outputType = "text"
	}
	checklist := t.Checklist
	if checklist == nil {
		checklist = []string{}
	}
	var rubric any = []any{}
	if t.Rubric != nil {
		rubric = t.Rubric
	}
	return map[string]any{
		"name":                 t.Name,
		"prompt_template":      t.Prompt,
		"score_type":           scoreType,
		"expected_answer":      nil,
		"pass_condition":       t.PassCondition,
		"evaluation_checklist": checklist,
		"evaluation_rubric":    rubric,
		"attempts":             1,
		"output_type":          outputType,
		"reference_image":      nil,
	}
}

func codePresenceCondition(required []any, sandbox obj) string {
	return stringify(obj{{"mode", "code_presence"}, {"required", filterTruthy(required)}, {"sandbox", sandbox}})
}

func externalCondition(mode string, payload obj) string {
	return stringify(append(obj{{"mode", mode}}, payload...))
}

func stringsToAny(in []string) []any {
	out := make([]any, len(in))
	for i, s := range in {
		out[i] = s
	}
	return out
}

func sliceLimit[T any](items []T, limit int) []T {
	if limit < 0 {
		limit = 0
	}
	if limit > len(items) {
		limit = len(items)
	}
	return items[:limit]
}

// nullRecordError mimics the TypeError JS raises when reading a property of null.
func nullRecordError(prop string) error {
	return fmt.Errorf("Cannot read properties of null (reading '%s')", prop)
}

func convertHumanEval(records []any, limit int) (map[string]any, error) {
	selected := sliceLimit(records, limit)
	tasks := make([]map[string]any, 0, len(selected))
	for index, item := range selected {
		if nullish(item) {
			return nil, nullRecordError("entry_point")
		}
		entryPoint := jsTrim(jsString(or(field(item, "entry_point"), "")))
		prompt := jsString(field(item, "prompt")) + "\n\nZwróć kompletny kod Python. Nie usuwaj sygnatury funkcji i nie dodawaj zbędnego tekstu poza kodem."
		taskID := field(item, "task_id")
		name := jsString(or(taskID, fmt.Sprintf("HumanEval/%d", index)))
		if entryPoint != "" {
			name += " — " + entryPoint
		}
		tasks = append(tasks, taskBase(taskSpec{
			Name:   name,
			Prompt: prompt,
			PassCondition: codePresenceCondition([]any{entryPoint}, obj{
				{"language", "python"},
				{"source", "HumanEval"},
				{"task_id", taskID},
				{"entry_point", entryPoint},
				{"tests", filterTruthy([]any{field(item, "test")})},
				{"canonical_solution", or(field(item, "canonical_solution"), nil)},
			}),
			Checklist: []string{"Czy odpowiedź zawiera wymaganą funkcję?", "Czy kod jest samodzielny?", "Sandbox powinien uruchomić testy HumanEval."},
		}))
	}
	return makeBenchmark(benchSpec{
		Name:           fmt.Sprintf("HumanEval (%d)", len(selected)),
		Category:       "Kod",
		SuiteName:      "HumanEval",
		Description:    "OpenAI HumanEval zaimportowany do BenchForge. Każdy task zawiera prompt, entry_point i testy w pass_condition.sandbox.",
		PromptTemplate: "HumanEval — zadania Python importowane z publicznego datasetu.",
		Tasks:          tasks,
	}), nil
}

var pythonFnRe = regexp.MustCompile(`(?:assert` + jsSpaceClass + `+)?([a-zA-Z_]\w*)` + jsSpaceClass + `*\(`)

func inferPythonFunctionName(text any, tests []any) string {
	sources := []string{jsString(or(text, ""))}
	for _, t := range tests {
		sources = append(sources, jsString(t))
	}
	for _, src := range sources {
		m := pythonFnRe.FindStringSubmatch(src)
		if m == nil || m[1] == "" {
			continue
		}
		switch m[1] {
		case "assert", "print", "len", "range":
			continue
		}
		return m[1]
	}
	return ""
}

func convertMbpp(records []any, limit int) (map[string]any, error) {
	selected := sliceLimit(records, limit)
	tasks := make([]map[string]any, 0, len(selected))
	for index, item := range selected {
		if nullish(item) {
			return nil, nullRecordError("test_list")
		}
		var tests []any
		if tl, ok := field(item, "test_list").([]any); ok {
			tests = tl
		} else if tl, ok := field(item, "tests").([]any); ok {
			tests = tl
		} else {
			tests = []any{}
		}
		entryPoint := inferPythonFunctionName(field(item, "text"), tests)
		taskID := field(item, "task_id")
		name := "MBPP " + jsString(coalesce(taskID, index))
		if entryPoint != "" {
			name += " — " + entryPoint
		}
		tasks = append(tasks, taskBase(taskSpec{
			Name:   name,
			Prompt: jsString(or(field(item, "text"), field(item, "prompt"), "")) + "\n\nZwróć kompletny kod Python spełniający testy.",
			PassCondition: codePresenceCondition([]any{entryPoint}, obj{
				{"language", "python"},
				{"source", "MBPP"},
				{"task_id", coalesce(taskID, nil)},
				{"entry_point", or(entryPoint, nil)},
				{"tests", tests},
				{"test_setup_code", or(field(item, "test_setup_code"), nil)},
				{"reference_code", or(field(item, "code"), nil)},
			}),
			Checklist: []string{"Czy kod definiuje wymaganą funkcję?", "Czy przechodzi testy assert z MBPP?"},
		}))
	}
	return makeBenchmark(benchSpec{
		Name:           fmt.Sprintf("MBPP (%d)", len(selected)),
		Category:       "Kod",
		SuiteName:      "MBPP",
		Description:    "Mostly Basic Python Problems zaimportowane do BenchForge. Testy assert są zapisane w pass_condition.sandbox.",
		PromptTemplate: "MBPP — krótkie zadania Python importowane z publicznego datasetu.",
		Tasks:          tasks,
	}), nil
}

var gsmAnswerRe = regexp.MustCompile(`####` + jsSpaceClass + `*([^\n]+)`)

func extractGsmAnswer(answer any) string {
	m := gsmAnswerRe.FindStringSubmatch(jsString(or(answer, "")))
	if m == nil {
		return ""
	}
	return jsTrim(strings.ReplaceAll(m[1], ",", ""))
}

func convertGsm8k(records []any, limit int) (map[string]any, error) {
	selected := sliceLimit(records, limit)
	tasks := make([]map[string]any, 0, len(selected))
	for index, item := range selected {
		if nullish(item) {
			return nil, nullRecordError("answer")
		}
		expected := extractGsmAnswer(field(item, "answer"))
		name := fmt.Sprintf("GSM8K %d", index+1)
		var pass any
		checklist := []string{}
		if expected != "" {
			name += " — " + expected
			pass = "Poprawna odpowiedź to " + expected + "."
			checklist = []string{"Odpowiedź końcowa zawiera " + expected + "."}
		}
		tasks = append(tasks, taskBase(taskSpec{
			Name:          name,
			Prompt:        jsString(field(item, "question")) + "\n\nRozwiąż zadanie krok po kroku, a na końcu podaj finalną odpowiedź w osobnej linii: Odpowiedź: <liczba>.",
			ScoreType:     "boolean",
			PassCondition: pass,
			Checklist:     checklist,
		}))
	}
	return makeBenchmark(benchSpec{
		Name:           fmt.Sprintf("GSM8K (%d)", len(selected)),
		Category:       "Logika",
		SuiteName:      "GSM8K",
		Description:    "Grade School Math 8K. Wymaga krótkiego rozumowania i finalnej odpowiedzi liczbowej.",
		PromptTemplate: "GSM8K — zadania matematyczne importowane z publicznego datasetu.",
		ScoreType:      "boolean",
		Tasks:          tasks,
	}), nil
}

// swebenchOptions mirrors the `options` object of convertSwebenchRows; empty
// strings behave like undefined (the JS uses `||`).
type swebenchOptions struct {
	Name           string
	Category       string
	SuiteName      string
	Description    string
	PromptTemplate string
}

func firstStr(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func convertSwebenchRows(rows []any, limit int, opts swebenchOptions) (map[string]any, error) {
	selected := sliceLimit(rows, limit)
	tasks := make([]map[string]any, 0, len(selected))
	source := firstStr(opts.SuiteName, opts.Name, "SWE-bench")
	for index, entry := range selected {
		if nullish(entry) {
			return nil, nullRecordError("row")
		}
		item := or(field(entry, "row"), entry)
		if nullish(item) {
			return nil, nullRecordError("repo")
		}
		repo := or(field(item, "repo"), "repo")
		instanceID := or(field(item, "instance_id"), fmt.Sprintf("swebench-%d", index+1))
		problem := or(field(item, "problem_statement"), field(item, "problem"), field(item, "issue"), field(item, "description"), "")
		imageText := or(field(item, "image"), field(item, "image_url"), field(item, "screenshot"), field(item, "visual"), nil)
		var b strings.Builder
		b.WriteString("Repo: " + jsString(repo))
		b.WriteString("\nInstance: " + jsString(instanceID))
		b.WriteString("\nBase commit: " + jsString(or(field(item, "base_commit"), "unknown")))
		b.WriteString("\n\nProblem statement:\n" + jsString(problem))
		if truthy(imageText) {
			b.WriteString("\n\nVisual/multimodal reference:\n" + jsString(imageText))
		}
		b.WriteString("\n\nZwróć propozycję patcha/diff oraz krótki opis zmiany.")
		tasks = append(tasks, taskBase(taskSpec{
			Name:   jsString(repo) + " — " + jsString(instanceID),
			Prompt: b.String(),
			PassCondition: externalCondition("swe_bench_patch", obj{
				{"source", source},
				{"repo", repo},
				{"instance_id", instanceID},
				{"base_commit", or(field(item, "base_commit"), nil)},
				{"test_patch", or(field(item, "test_patch"), nil)},
				{"patch", or(field(item, "patch"), nil)},
				{"language", or(field(item, "language"), field(item, "repo_language"), nil)},
				{"image", imageText},
			}),
			Checklist:  []string{"Czy odpowiedź zawiera konkretny patch/diff?", "Czy zmiana odnosi się do problem statement?", "Docelowo sandbox powinien uruchomić test_patch."},
			OutputType: "markdown",
		}))
	}
	return makeBenchmark(benchSpec{
		Name:           fmt.Sprintf("%s (%d)", firstStr(opts.Name, "SWE-bench Lite"), len(selected)),
		Category:       firstStr(opts.Category, "Kod"),
		SuiteName:      firstStr(opts.SuiteName, opts.Name, "SWE-bench Lite"),
		Description:    firstStr(opts.Description, "SWE-bench w formacie BenchForge. Zadania repo/patch pod Repo Sandbox."),
		PromptTemplate: firstStr(opts.PromptTemplate, firstStr(opts.Name, "SWE-bench")+" — naprawy repozytoriów importowane z HuggingFace datasets-server."),
		Tasks:          tasks,
	}), nil
}

// ---------------------------------------------------------------------------
// Fallback / curated packs

func mustBench(b map[string]any, err error) map[string]any {
	if err != nil {
		panic(err) // fallback fixtures are static and never contain null records
	}
	return b
}

func fallbackHumanEval(limit int) map[string]any {
	records := []any{
		map[string]any{"task_id": "HumanEval/0", "entry_point": "has_close_elements", "prompt": "from typing import List\n\ndef has_close_elements(numbers: List[float], threshold: float) -> bool:\n    \"\"\" Check if in given list of numbers, are any two numbers closer to each other than given threshold. \"\"\"", "test": "assert has_close_elements([1.0, 2.0, 3.0], 0.5) == False\nassert has_close_elements([1.0, 2.8, 3.0], 0.3) == True"},
		map[string]any{"task_id": "HumanEval/1", "entry_point": "separate_paren_groups", "prompt": "def separate_paren_groups(paren_string: str) -> List[str]:\n    \"\"\" Separate groups of nested parentheses. \"\"\"", "test": "assert separate_paren_groups(\"( ) (( ))\") == [\"()\", \"(())\"]"},
		map[string]any{"task_id": "HumanEval/2", "entry_point": "truncate_number", "prompt": "def truncate_number(number: float) -> float:\n    \"\"\" Return decimal part of a positive floating point number. \"\"\"", "test": "assert truncate_number(3.5) == 0.5"},
	}
	return mustBench(convertHumanEval(records, minInt(limit, 3)))
}

func fallbackMbpp(limit int) map[string]any {
	records := []any{
		map[string]any{"task_id": float64(11), "text": "Write a python function to remove first and last occurrence of a given character from the string.", "test_list": []any{`assert remove_Occ("hello","l") == "heo"`}},
		map[string]any{"task_id": float64(12), "text": "Write a function to sort a list of tuples by the second item.", "test_list": []any{`assert sort_tuple([(1, 3), (2, 1)]) == [(2, 1), (1, 3)]`}},
		map[string]any{"task_id": float64(13), "text": "Write a function to find the square root of a number.", "test_list": []any{`assert square_root(4) == 2`}},
	}
	return mustBench(convertMbpp(records, minInt(limit, 3)))
}

func fallbackGsm8k(limit int) map[string]any {
	records := []any{
		map[string]any{"question": "Jan ma 3 jabłka i kupuje jeszcze 4. Ile ma jabłek?", "answer": "Jan ma 3 + 4 = 7 jabłek.\n#### 7"},
		map[string]any{"question": "Pudełko ma 5 rzędów po 6 cukierków. Ile cukierków jest razem?", "answer": "5 * 6 = 30.\n#### 30"},
		map[string]any{"question": "Ala miała 20 zł i wydała 8 zł. Ile jej zostało?", "answer": "20 - 8 = 12.\n#### 12"},
	}
	return mustBench(convertGsm8k(records, minInt(limit, 3)))
}

func fallbackMmluMini(limit int) map[string]any {
	type mmlu struct {
		subject, question string
		options           []string
		answer            string
	}
	items := sliceLimit([]mmlu{
		{"Biologia", "Która organella odpowiada głównie za produkcję ATP?", []string{"A. Rybosom", "B. Mitochondrium", "C. Aparat Golgiego", "D. Lizosom"}, "B"},
		{"Historia", "W którym roku zakończyła się II wojna światowa?", []string{"A. 1939", "B. 1941", "C. 1945", "D. 1950"}, "C"},
		{"Matematyka", "Ile wynosi pochodna x^2?", []string{"A. x", "B. 2x", "C. x^3", "D. 2"}, "B"},
		{"Fizyka", "Jednostką siły w układzie SI jest:", []string{"A. Dżul", "B. Wat", "C. Newton", "D. Pascal"}, "C"},
		{"Chemia", "Jakie pH ma roztwór obojętny w 25°C?", []string{"A. 0", "B. 7", "C. 10", "D. 14"}, "B"},
		{"Informatyka", "Która struktura danych działa zgodnie z zasadą FIFO?", []string{"A. Stos", "B. Kolejka", "C. Kopiec", "D. Drzewo"}, "B"},
	}, limit)
	tasks := make([]map[string]any, 0, len(items))
	for index, it := range items {
		tasks = append(tasks, taskBase(taskSpec{
			Name:          fmt.Sprintf("%s %d", it.subject, index+1),
			Prompt:        it.question + "\n\n" + strings.Join(it.options, "\n") + "\n\nOdpowiedz samą literą A/B/C/D.",
			ScoreType:     "boolean",
			PassCondition: "Poprawna odpowiedź to " + it.answer + ".",
			Checklist:     []string{"Odpowiedź zawiera literę " + it.answer + "."},
		}))
	}
	return makeBenchmark(benchSpec{
		Name:           fmt.Sprintf("MMLU mini (%d)", len(items)),
		Category:       "Wiedza",
		SuiteName:      "MMLU mini",
		Description:    "Mały, wbudowany zestaw pytań wielokrotnego wyboru w stylu MMLU.",
		PromptTemplate: "MMLU mini — pytania wielokrotnego wyboru.",
		ScoreType:      "boolean",
		Tasks:          tasks,
	})
}

func fallbackSwebench(limit int) map[string]any {
	rows := []any{
		map[string]any{"repo": "django/django", "instance_id": "benchforge-demo-django", "base_commit": "demo", "problem_statement": "A model field validation error is unclear. Propose a patch improving the error message and add a regression test.", "patch": nil, "test_patch": nil},
		map[string]any{"repo": "psf/requests", "instance_id": "benchforge-demo-requests", "base_commit": "demo", "problem_statement": "Session should preserve a custom header across redirects. Propose a patch and tests.", "patch": nil, "test_patch": nil},
	}
	return mustBench(convertSwebenchRows(rows, minInt(limit, 2), swebenchOptions{}))
}

func fallbackSwebenchFamily(id string, limit int) map[string]any {
	meta := packMeta(id)
	row := func(repo, suffix, statement, lang string) any {
		return map[string]any{"repo": repo, "instance_id": id + suffix, "base_commit": "demo", "problem_statement": meta.Name + statement, "language": lang, "patch": nil, "test_patch": nil}
	}
	rows := []any{
		row("django/django", "-django-demo", " demo: fix a validation edge case and add a regression test.", "python"),
		row("pallets/flask", "-flask-demo", " demo: repair request handling behavior and add tests.", "python"),
		row("qutebrowser/qutebrowser", "-qutebrowser-demo", " demo: investigate UI/browser issue and propose a patch.", "python"),
		row("gravitational/teleport", "-teleport-demo", " demo: fix a Go service regression and update tests.", "go"),
	}
	return mustBench(convertSwebenchRows(rows, minInt(limit, len(rows)), swebenchOptions{Name: meta.Name, SuiteName: meta.Name, Category: meta.Category, Description: meta.Description}))
}

func fallbackVoxelBench(limit int) map[string]any {
	items := sliceLimit([]exactItem{
		{Name: "Voxel — count cubes", Context: "Voxel grid layers z=0..1. z0: ##. / .#. / ... ; z1: #.. / ... / ..#", Question: "How many filled voxels (#) are in the grid?", Answer: "5"},
		{Name: "Voxel — neighbors", Context: "3D grid coordinates use x,y,z. Filled voxels: (0,0,0), (1,0,0), (1,1,0), (1,1,1).", Question: "How many 6-connected neighbors does voxel (1,1,0) have?", Answer: "2"},
		{Name: "Voxel — shortest path", Context: "3x3x1 grid, S at (0,0,0), E at (2,2,0), blocked: (1,1,0). Movement is 4-neighbor in the layer.", Question: "What is the shortest path length from S to E?", Answer: "4"},
		{Name: "Voxel — projection", Context: "Filled voxels: (0,0,0), (0,0,1), (1,0,0), (2,2,0).", Question: "How many occupied cells are visible in top-down XY projection?", Answer: "3"},
	}, limit)
	return makeExactPack("voxelbench-mini", len(items), items)
}

func fallbackMazeTools(limit int) map[string]any {
	type maze struct {
		name       string
		grid       []string
		start, end []int
	}
	items := sliceLimit([]maze{
		{"Maze tools — prosta siatka 5x5", []string{"S....", "###..", "...#.", ".#...", "...#E"}, []int{0, 0}, []int{4, 4}},
		{"Maze tools — korytarz", []string{"S#...", ".#.#.", ".#.#.", "...#.", "###.E"}, []int{0, 0}, []int{4, 4}},
		{"Maze tools — zakręty", []string{"S..#.", "##.#.", "...#.", ".###.", "....E"}, []int{0, 0}, []int{4, 4}},
		{"Maze tools — większa siatka", []string{"S.....", ".####.", ".#....", ".#.###", ".#...E", "......"}, []int{0, 0}, []int{5, 4}},
	}, limit)
	tasks := make([]map[string]any, 0, len(items))
	for _, it := range items {
		tasks = append(tasks, taskBase(taskSpec{
			Name:      it.name,
			Prompt:    "Masz labirynt jako siatkę tekstową. Znaki: S=start, E=cel, #=ściana, .=wolne pole.\n\n" + strings.Join(it.grid, "\n") + "\n\nUżyj narzędzi BenchForge, najlepiej python.run do BFS/DFS oraz image.draw_path_svg do zapisania wizualizacji. Zwróć JSON: {\"path\": [[x,y], ...], \"tool_artifacts\": [\"path-overlay.svg\"]}.",
			ScoreType: "boolean",
			PassCondition: externalCondition("tool_maze_path", obj{
				{"source", "BenchForge Tool Benchmark"},
				{"allowed_tools", []string{"python.run", "node.run", "file.write", "file.read", "file.list", "image.draw_path_svg"}},
				{"required_artifacts", []string{"path.json", "path-overlay.svg"}},
				{"grid", it.grid},
				{"start", it.start},
				{"end", it.end},
				{"coordinates", "x,y with x as column and y as row"},
			}),
			Checklist:  []string{"Czy użyto narzędzia do obliczenia ścieżki?", "Czy ścieżka zaczyna się w S i kończy w E?", "Czy ścieżka nie przechodzi przez ściany?", "Czy zapisano artefakty path.json i path-overlay.svg?"},
			OutputType: "markdown",
		}))
	}
	return makeBenchmark(benchSpec{
		Name:           fmt.Sprintf("Maze Tool Solving mini (%d)", len(items)),
		Category:       "Wizja",
		SuiteName:      "Tool Benchmarks",
		Description:    "Benchmark agentowy pod Tool Runtime. Model powinien użyć narzędzi do wyznaczenia ścieżki w labiryncie i wygenerować path.json oraz SVG z narysowaną trasą.",
		PromptTemplate: "Maze Tool Solving — użyj narzędzi BenchForge do rozwiązania labiryntu.",
		ScoreType:      "boolean",
		Tasks:          tasks,
	})
}

func mcpCondition(mcpAllowed []string, evidence string) string {
	var ev any
	if evidence != "" {
		ev = evidence
	}
	if mcpAllowed == nil {
		mcpAllowed = []string{}
	}
	return externalCondition("mcp_eval", obj{
		{"source", "BenchForge MCP Benchmark"},
		{"allowed_tools", []string{"mcp.list_tools", "mcp.call"}},
		{"denied_tools", []string{"python.run", "node.run", "file.write", "file.read", "file.list", "image.draw_path_svg"}},
		{"max_calls", 8},
		{"timeout_ms", 20000},
		{"required_artifacts", []string{}},
		{"mcp_allowed_tools", mcpAllowed},
		{"mcp_denied_tools", []string{}},
		{"expected_evidence", ev},
	})
}

type mcpItem struct {
	name, prompt, evidence string
	allowed                []string
}

type mcpPackSpec struct {
	name, category, description, promptTemplate string
	promptSuffix, defaultEvidence               string
	checklist                                   []string
	items                                       []mcpItem
}

func buildMcpPack(spec mcpPackSpec, limit int) map[string]any {
	items := sliceLimit(spec.items, limit)
	tasks := make([]map[string]any, 0, len(items))
	for _, it := range items {
		ev := it.evidence
		if ev == "" {
			ev = spec.defaultEvidence
		}
		tasks = append(tasks, taskBase(taskSpec{
			Name:          it.name,
			Prompt:        it.prompt + spec.promptSuffix,
			PassCondition: mcpCondition(it.allowed, ev),
			Checklist:     spec.checklist,
			OutputType:    "markdown",
		}))
	}
	return makeBenchmark(benchSpec{
		Name:           fmt.Sprintf("%s (%d)", spec.name, len(items)),
		Category:       spec.category,
		SuiteName:      "MCP Benchmarks",
		Description:    spec.description,
		PromptTemplate: spec.promptTemplate,
		ScoreType:      "numeric",
		Tasks:          tasks,
	})
}

func fallbackMcpFilesystem(limit int) map[string]any {
	return buildMcpPack(mcpPackSpec{
		name:           "MCP Filesystem mini",
		category:       "Kod",
		description:    "Benchmark agentowy dla MCP filesystem. Wymaga skonfigurowanego serwera MCP filesystem w Ustawieniach.",
		promptTemplate: "MCP Filesystem mini — użyj mcp.list_tools i mcp.call.",
		promptSuffix:   "\n\nNajpierw użyj mcp.list_tools, potem mcp.call na właściwym serverId/toolName. W odpowiedzi końcowej podaj użyte tool calls oraz wynik.",
		checklist:      []string{"Czy użyto mcp.list_tools?", "Czy użyto mcp.call?", "Czy odpowiedź opiera się na danych z toola?", "Czy podano ścieżki/nazwy źródeł?"},
		items: []mcpItem{
			{"MCP FS — list root", "Użyj MCP filesystem tool do listowania dostępnego katalogu/roota serwera. Zwróć listę plików/katalogów i nazwę użytego toola.", "mcp filesystem list/read tool used", []string{"list_directory", "read_file", "directory_tree"}},
			{"MCP FS — read file", "Użyj MCP filesystem tool do odczytania wskazanego pliku README lub package.json, jeśli istnieje. Podaj 3 kluczowe fakty i ścieżkę pliku.", "file content cited", []string{"read_file", "list_directory", "directory_tree"}},
			{"MCP FS — find config", "Użyj MCP filesystem tool, aby znaleźć pliki konfiguracyjne projektu (np. package.json, tsconfig, README). Zwróć krótkie podsumowanie.", "config files listed", []string{"list_directory", "read_file", "search_files", "directory_tree"}},
			{"MCP FS — summarize tree", "Użyj MCP filesystem tool do zbadania struktury katalogów i opisz główne moduły projektu.", "tree summary from MCP", []string{"directory_tree", "list_directory", "read_file"}},
		},
	}, limit)
}

func fallbackMcpSqlite(limit int) map[string]any {
	return buildMcpPack(mcpPackSpec{
		name:            "MCP SQLite mini",
		category:        "Kod",
		description:     "Benchmark agentowy dla MCP database/sqlite. Wymaga skonfigurowanego serwera MCP do bazy danych.",
		promptTemplate:  "MCP SQLite mini — użyj mcp.list_tools i mcp.call.",
		promptSuffix:    "\n\nNajpierw sprawdź dostępne MCP tools, potem wykonaj właściwe zapytanie przez mcp.call.",
		defaultEvidence: "SQL query result from MCP",
		checklist:       []string{"Czy użyto MCP database tool?", "Czy odpowiedź zawiera zapytanie lub nazwę toola?", "Czy wynik pochodzi z danych zwróconych przez MCP?"},
		items: []mcpItem{
			{name: "MCP DB — list tables", prompt: "Użyj MCP database/sqlite tool do sprawdzenia listy tabel. Zwróć nazwy tabel i tool, którego użyto.", allowed: []string{"list_tables", "query", "execute_query", "describe_table"}},
			{name: "MCP DB — describe schema", prompt: "Użyj MCP database/sqlite tool do opisania schematu najważniejszej tabeli. Zwróć kolumny i typy.", allowed: []string{"describe_table", "query", "execute_query", "list_tables"}},
			{name: "MCP DB — count rows", prompt: "Użyj MCP database/sqlite tool do policzenia rekordów w wybranej tabeli. Zwróć zapytanie i wynik.", allowed: []string{"query", "execute_query", "list_tables"}},
			{name: "MCP DB — aggregate", prompt: "Użyj MCP database/sqlite tool do wykonania prostego GROUP BY lub agregacji, jeśli dane na to pozwalają. Zwróć zapytanie i wynik.", allowed: []string{"query", "execute_query"}},
		},
	}, limit)
}

func fallbackMcpBrowserSearch(limit int) map[string]any {
	tools := []string{"search", "web_search", "fetch", "browser_navigate", "browser_snapshot"}
	return buildMcpPack(mcpPackSpec{
		name:            "MCP Browser/Search mini",
		category:        "Wiedza",
		description:     "Benchmark agentowy dla MCP browser/search. Wymaga skonfigurowanego serwera MCP z narzędziami wyszukiwania/przeglądarki.",
		promptTemplate:  "MCP Browser/Search mini — użyj mcp.list_tools i mcp.call.",
		promptSuffix:    "\n\nNie odpowiadaj z pamięci. Użyj mcp.call i w finalnej odpowiedzi podaj źródło/URL.",
		defaultEvidence: "cited URL/source from MCP",
		checklist:       []string{"Czy użyto MCP search/browser?", "Czy odpowiedź zawiera źródło lub URL?", "Czy odpowiedź nie opiera się wyłącznie na pamięci modelu?"},
		items: []mcpItem{
			{name: "MCP Search — current fact", prompt: "Użyj MCP browser/search tool, aby znaleźć aktualną oficjalną stronę projektu Model Context Protocol. Podaj URL i krótki opis.", allowed: tools},
			{name: "MCP Search — verify release", prompt: "Użyj MCP browser/search tool, aby sprawdzić ostatnią informację o wybranym projekcie open-source. Podaj źródło.", allowed: tools},
			{name: "MCP Search — compare sources", prompt: "Użyj MCP browser/search tool, aby znaleźć dwa źródła o tym samym temacie i porównać ich informacje.", allowed: tools},
			{name: "MCP Search — cite answer", prompt: "Użyj MCP browser/search tool i odpowiedz na pytanie z cytatem/URL: czym jest SWE-bench?", allowed: tools},
		},
	}, limit)
}

func fallbackMcpGit(limit int) map[string]any {
	return buildMcpPack(mcpPackSpec{
		name:            "MCP Git mini",
		category:        "Kod",
		description:     "Benchmark agentowy dla MCP git. Wymaga skonfigurowanego serwera MCP z narzędziami git.",
		promptTemplate:  "MCP Git mini — użyj mcp.list_tools i mcp.call.",
		promptSuffix:    "\n\nNajpierw użyj mcp.list_tools, potem mcp.call z właściwym narzędziem git.",
		defaultEvidence: "git output from MCP",
		checklist:       []string{"Czy użyto MCP git tool?", "Czy odpowiedź zawiera konkretne pliki/commity/diff?", "Czy wnioski wynikają z danych MCP?"},
		items: []mcpItem{
			{name: "MCP Git — status", prompt: "Użyj MCP git tool, aby sprawdzić status repozytorium. Podsumuj zmienione pliki.", allowed: []string{"git_status", "status", "git_diff", "diff"}},
			{name: "MCP Git — diff summary", prompt: "Użyj MCP git tool, aby odczytać diff i streścić najważniejsze zmiany.", allowed: []string{"git_diff", "diff", "git_status"}},
			{name: "MCP Git — log", prompt: "Użyj MCP git tool, aby sprawdzić ostatnie commity i opisać styl commitów.", allowed: []string{"git_log", "log", "git_status"}},
			{name: "MCP Git — changed tests", prompt: "Użyj MCP git tool, aby znaleźć czy zmiany dotyczą testów lub benchmarków.", allowed: []string{"git_status", "git_diff", "diff"}},
		},
	}, limit)
}

var answerLetterRe = regexp.MustCompile(`^[A-D]$`)

func makeChoicePack(id string, limit int, items []choiceItem) map[string]any {
	meta := packMeta(id)
	selected := sliceLimit(items, limit)
	tasks := make([]map[string]any, 0, len(selected))
	for index, it := range selected {
		options := ""
		if it.Options != nil {
			options = "\n\n" + strings.Join(it.Options, "\n")
		}
		ctx := ""
		if it.Context != "" {
			ctx = it.Context + "\n\n"
		}
		hint := "tak/nie albo dokładną odpowiedzią"
		if answerLetterRe.MatchString(it.Answer) {
			hint = "samą literą A/B/C/D"
		}
		tasks = append(tasks, taskBase(taskSpec{
			Name:          firstStr(it.Name, fmt.Sprintf("%s %d", meta.Name, index+1)),
			Prompt:        ctx + it.Question + options + "\n\nOdpowiedz krótko: " + hint + ".",
			ScoreType:     "boolean",
			PassCondition: "Poprawna odpowiedź to " + it.Answer + ".",
			Checklist:     []string{"Odpowiedź zawiera " + it.Answer + "."},
		}))
	}
	return makeBenchmark(benchSpec{
		Name:           fmt.Sprintf("%s (%d)", meta.Name, len(selected)),
		Category:       meta.Category,
		SuiteName:      meta.Name,
		Description:    meta.Description + " Importowany jako zadania wielokrotnego wyboru/tak-nie w formacie BenchForge.",
		PromptTemplate: meta.Name + " — wybierz poprawną odpowiedź zgodnie z instrukcją w zadaniu.",
		ScoreType:      "boolean",
		Tasks:          tasks,
	})
}

func makeExactPack(id string, limit int, items []exactItem) map[string]any {
	meta := packMeta(id)
	selected := sliceLimit(items, limit)
	tasks := make([]map[string]any, 0, len(selected))
	for index, it := range selected {
		ctx := ""
		if it.Context != "" {
			ctx = it.Context + "\n\n"
		}
		tasks = append(tasks, taskBase(taskSpec{
			Name:          firstStr(it.Name, fmt.Sprintf("%s %d", meta.Name, index+1)),
			Prompt:        ctx + it.Question + "\n\nPodaj finalną odpowiedź krótko i jednoznacznie.",
			ScoreType:     "boolean",
			PassCondition: "Poprawna odpowiedź to " + it.Answer + ".",
			Checklist:     []string{"Odpowiedź zawiera " + it.Answer + "."},
		}))
	}
	return makeBenchmark(benchSpec{
		Name:           fmt.Sprintf("%s (%d)", meta.Name, len(selected)),
		Category:       meta.Category,
		SuiteName:      meta.Name,
		Description:    meta.Description + " Importowany jako zadania z krótką oczekiwaną odpowiedzią.",
		PromptTemplate: meta.Name + " — odpowiedz zgodnie z kontekstem zadania.",
		ScoreType:      "boolean",
		Tasks:          tasks,
	})
}

func makeManualPack(id string, limit int, items []manualItem) map[string]any {
	meta := packMeta(id)
	selected := sliceLimit(items, limit)
	tasks := make([]map[string]any, 0, len(selected))
	for index, it := range selected {
		checklist := it.Checklist
		if checklist == nil {
			checklist = []string{"Czy odpowiedź spełnia wszystkie wymagania?", "Czy jest poprawna merytorycznie?", "Czy jest zwięzła i użyteczna?"}
		}
		basePoints := int(math.Floor(100 / float64(len(checklist))))
		rubric := make([]map[string]any, 0, len(checklist))
		for ri, label := range checklist {
			points := basePoints
			if ri == len(checklist)-1 {
				points = 100 - basePoints*(len(checklist)-1)
			}
			rubric = append(rubric, map[string]any{"id": fmt.Sprintf("criterion_%d", ri+1), "label": label, "points": points, "type": "scale", "min": 0})
		}
		tasks = append(tasks, taskBase(taskSpec{
			Name:          firstStr(it.Name, fmt.Sprintf("%s %d", meta.Name, index+1)),
			Prompt:        it.Prompt,
			PassCondition: "Oceń ręcznie zgodność z instrukcją w skali 0-100.",
			Checklist:     checklist,
			Rubric:        rubric,
			OutputType:    "markdown",
		}))
	}
	return makeBenchmark(benchSpec{
		Name:           fmt.Sprintf("%s (%d)", meta.Name, len(selected)),
		Category:       meta.Category,
		SuiteName:      meta.Name,
		Description:    meta.Description + " Zadania są importowane jako markdown/manual-eval — dobre pod porównania jakościowe albo przyszły judge.",
		PromptTemplate: meta.Name + " — zadania jakościowe/manual-eval.",
		ScoreType:      "numeric",
		Tasks:          tasks,
	})
}

func makeCodePack(id string, limit int, items []codeItem) map[string]any {
	meta := packMeta(id)
	selected := sliceLimit(items, limit)
	tasks := make([]map[string]any, 0, len(selected))
	for index, it := range selected {
		lang := firstStr(it.Language, "python")
		tests := it.Tests
		if tests == nil {
			tests = []string{}
		}
		tasks = append(tasks, taskBase(taskSpec{
			Name:          firstStr(it.Name, fmt.Sprintf("%s %d", meta.Name, index+1)),
			Prompt:        it.Prompt + "\n\nZwróć kompletny kod.",
			PassCondition: codePresenceCondition(stringsToAny(it.Required), obj{{"language", lang}, {"source", meta.Name}, {"tests", tests}}),
			Checklist:     []string{"Czy kod zawiera wymaganą funkcję?", "Czy rozwiązanie jest kompletne?", "Sandbox powinien uruchomić testy."},
			OutputType:    "text",
		}))
	}
	return makeBenchmark(benchSpec{
		Name:           fmt.Sprintf("%s (%d)", meta.Name, len(selected)),
		Category:       "Kod",
		SuiteName:      meta.Name,
		Description:    meta.Description + " Kod importowany z warunkami code_presence i metadanymi sandboxa.",
		PromptTemplate: meta.Name + " — zadania kodowe.",
		Tasks:          tasks,
	})
}

func fallbackPack(id string, limit int) map[string]any {
	switch id {
	case "humaneval":
		return fallbackHumanEval(limit)
	case "mbpp":
		return fallbackMbpp(limit)
	case "gsm8k":
		return fallbackGsm8k(limit)
	case "swebench-lite":
		return fallbackSwebench(limit)
	case "swebench-full", "swebench-verified", "swebench-multilingual", "swebench-multimodal", "swebench-pro":
		return fallbackSwebenchFamily(id, limit)
	case "voxelbench-mini":
		return fallbackVoxelBench(limit)
	case "maze-tools-mini":
		return fallbackMazeTools(limit)
	case "mcp-filesystem-mini":
		return fallbackMcpFilesystem(limit)
	case "mcp-sqlite-mini":
		return fallbackMcpSqlite(limit)
	case "mcp-browser-search-mini":
		return fallbackMcpBrowserSearch(limit)
	case "mcp-git-mini":
		return fallbackMcpGit(limit)
	case "mmlu-mini":
		return fallbackMmluMini(limit)
	}
	if p, ok := choicePacks[id]; ok {
		return makeChoicePack(id, limit, p)
	}
	if p, ok := exactPacks[id]; ok {
		return makeExactPack(id, limit, p)
	}
	if p, ok := codePacks[id]; ok {
		return makeCodePack(id, limit, p)
	}
	if p, ok := manualPacks[id]; ok {
		return makeManualPack(id, limit, p)
	}
	return fallbackMmluMini(limit)
}
