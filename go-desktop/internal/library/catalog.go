package library

type catalogItem struct {
	ID               string
	Name             string
	Source           string
	Description      string
	Category         string
	DefaultLimit     int
	RecommendedLimit int
	Homepage         string // empty = no homepage key (JS: property absent)
}

var catalog = []catalogItem{
	{ID: "humaneval", Name: "HumanEval", Source: "OpenAI / GitHub", Description: "164 zadania Python z promptem, entry_point i testami jednostkowymi. Importuje się jako code_presence + przyszły sandbox Python.", Category: "Kod", DefaultLimit: 164, RecommendedLimit: 40, Homepage: "https://github.com/openai/human-eval"},
	{ID: "mbpp", Name: "MBPP", Source: "Google Research / GitHub", Description: "Mostly Basic Python Problems — krótkie zadania Python z testami assert. Import jako code_presence + przyszły sandbox Python.", Category: "Kod", DefaultLimit: 100, RecommendedLimit: 50, Homepage: "https://github.com/google-research/google-research/tree/master/mbpp"},
	{ID: "gsm8k", Name: "GSM8K", Source: "OpenAI / GitHub", Description: "Zadania matematyczne grade-school z oczekiwaną odpowiedzią końcową.", Category: "Logika", DefaultLimit: 100, RecommendedLimit: 50, Homepage: "https://github.com/openai/grade-school-math"},
	{ID: "swebench-lite", Name: "SWE-bench Lite", Source: "Princeton NLP / HuggingFace", Description: "Zadania naprawy repozytoriów. Importuje problem statement i metadane patch/test_patch pod przyszły sandbox repozytoriów.", Category: "Kod", DefaultLimit: 50, RecommendedLimit: 20, Homepage: "https://www.swebench.com/"},
	{ID: "swebench-full", Name: "SWE-bench Full", Source: "Princeton NLP / HuggingFace", Description: "Pełny SWE-bench: repo/patch tasks dla napraw prawdziwych issue w projektach open-source. Wymaga Repo Sandbox.", Category: "Kod", DefaultLimit: 100, RecommendedLimit: 20, Homepage: "https://www.swebench.com/original.html"},
	{ID: "swebench-verified", Name: "SWE-bench Verified", Source: "Princeton NLP / HuggingFace", Description: "Human-filtered SWE-bench Verified: 500 zweryfikowanych zadań repo/patch. Wymaga Repo Sandbox.", Category: "Kod", DefaultLimit: 100, RecommendedLimit: 20, Homepage: "https://www.swebench.com/verified.html"},
	{ID: "swebench-multilingual", Name: "SWE-bench Multilingual", Source: "SWE-bench / HuggingFace", Description: "SWE-bench Multilingual: zadania software engineering w wielu językach programowania. Wymaga Repo Sandbox.", Category: "Kod", DefaultLimit: 100, RecommendedLimit: 20, Homepage: "https://www.swebench.com/multilingual-leaderboard.html"},
	{ID: "swebench-multimodal", Name: "SWE-bench Multimodal", Source: "SWE-bench / HuggingFace", Description: "SWE-bench Multimodal: issue z elementami wizualnymi i repo/patch evaluation. Wymaga Repo Sandbox; obrazy/metadane są zachowane w pass_condition.", Category: "Wizja", DefaultLimit: 100, RecommendedLimit: 20, Homepage: "https://www.swebench.com/multimodal.html"},
	{ID: "swebench-pro", Name: "SWE-bench Pro", Source: "Scale AI / GitHub curated", Description: "SWE-bench Pro: długohoryzontowe zadania software engineering. Import jako repo_patch placeholder pod lokalne repo/testCommand.", Category: "Kod", DefaultLimit: 20, RecommendedLimit: 10, Homepage: "https://github.com/scaleapi/SWE-bench_Pro-os"},
	{ID: "mmlu-mini", Name: "MMLU mini", Source: "BenchForge curated fallback", Description: "Mały zestaw pytań wielokrotnego wyboru w stylu MMLU, od razu w formacie BenchForge.", Category: "Wiedza", DefaultLimit: 12, RecommendedLimit: 12, Homepage: "https://github.com/hendrycks/test"},
	{ID: "truthfulqa-mini", Name: "TruthfulQA mini", Source: "BenchForge curated / TruthfulQA style", Description: "Pytania sprawdzające prawdomówność i odporność na popularne fałszywe założenia.", Category: "Wiedza", DefaultLimit: 12, RecommendedLimit: 8, Homepage: "https://github.com/sylinrl/TruthfulQA"},
	{ID: "hellaswag-mini", Name: "HellaSwag mini", Source: "BenchForge curated / HellaSwag style", Description: "Zdroworozsądkowe kończenie scenariuszy — model wybiera najbardziej prawdopodobną kontynuację.", Category: "Logika", DefaultLimit: 12, RecommendedLimit: 8, Homepage: "https://rowanzellers.com/hellaswag/"},
	{ID: "arc-easy-mini", Name: "ARC Easy mini", Source: "BenchForge curated / AI2 ARC style", Description: "Łatwiejsze pytania naukowe wielokrotnego wyboru.", Category: "Wiedza", DefaultLimit: 12, RecommendedLimit: 8, Homepage: "https://allenai.org/data/arc"},
	{ID: "arc-challenge-mini", Name: "ARC Challenge mini", Source: "BenchForge curated / AI2 ARC style", Description: "Trudniejsze pytania naukowe wymagające rozumowania.", Category: "Wiedza", DefaultLimit: 12, RecommendedLimit: 8, Homepage: "https://allenai.org/data/arc"},
	{ID: "openbookqa-mini", Name: "OpenBookQA mini", Source: "BenchForge curated / OpenBookQA style", Description: "Pytania naukowe wymagające użycia krótkiej wiedzy/faktu.", Category: "Wiedza", DefaultLimit: 10, RecommendedLimit: 8, Homepage: "https://allenai.org/data/open-book-qa"},
	{ID: "winogrande-mini", Name: "WinoGrande mini", Source: "BenchForge curated / WinoGrande style", Description: "Rozstrzyganie referencji w zdaniach — test rozumienia języka i kontekstu.", Category: "Logika", DefaultLimit: 10, RecommendedLimit: 8, Homepage: "https://winogrande.allenai.org/"},
	{ID: "boolq-mini", Name: "BoolQ mini", Source: "BenchForge curated / BoolQ style", Description: "Pytania tak/nie na podstawie krótkiego pasażu.", Category: "Wiedza", DefaultLimit: 10, RecommendedLimit: 8, Homepage: "https://github.com/google-research-datasets/boolean-questions"},
	{ID: "piqa-mini", Name: "PIQA mini", Source: "BenchForge curated / PIQA style", Description: "Physical Interaction QA — wybór rozwiązania zgodnego z intuicją fizyczną.", Category: "Logika", DefaultLimit: 10, RecommendedLimit: 8, Homepage: "https://yonatanbisk.com/piqa/"},
	{ID: "commonsenseqa-mini", Name: "CommonsenseQA mini", Source: "BenchForge curated / CommonsenseQA style", Description: "Pytania wielokrotnego wyboru sprawdzające wiedzę potoczną.", Category: "Logika", DefaultLimit: 10, RecommendedLimit: 8, Homepage: "https://www.tau-nlp.org/commonsenseqa"},
	{ID: "strategyqa-mini", Name: "StrategyQA mini", Source: "BenchForge curated / StrategyQA style", Description: "Pytania tak/nie wymagające kilku kroków rozumowania.", Category: "Logika", DefaultLimit: 10, RecommendedLimit: 8, Homepage: "https://allenai.org/data/strategyqa"},
	{ID: "drop-mini", Name: "DROP mini", Source: "BenchForge curated / DROP style", Description: "Czytanie ze zrozumieniem z prostą arytmetyką na tekście.", Category: "Logika", DefaultLimit: 10, RecommendedLimit: 8, Homepage: "https://allenai.org/data/drop"},
	{ID: "squad-mini", Name: "SQuAD mini", Source: "BenchForge curated / SQuAD style", Description: "Ekstrakcyjne QA — odpowiedź ma wynikać z podanego kontekstu.", Category: "Wiedza", DefaultLimit: 10, RecommendedLimit: 8, Homepage: "https://rajpurkar.github.io/SQuAD-explorer/"},
	{ID: "hotpotqa-mini", Name: "HotpotQA mini", Source: "BenchForge curated / HotpotQA style", Description: "Multi-hop QA — pytania wymagające połączenia dwóch informacji.", Category: "Logika", DefaultLimit: 10, RecommendedLimit: 8, Homepage: "https://hotpotqa.github.io/"},
	{ID: "natural-questions-mini", Name: "Natural Questions mini", Source: "BenchForge curated / NQ style", Description: "Naturalne pytania użytkowników z krótką oczekiwaną odpowiedzią.", Category: "Wiedza", DefaultLimit: 10, RecommendedLimit: 8, Homepage: "https://ai.google.com/research/NaturalQuestions"},
	{ID: "bbh-mini", Name: "BBH mini", Source: "BenchForge curated / BIG-Bench Hard style", Description: "Trudniejsze zadania rozumowania symbolicznego i instrukcyjnego.", Category: "Logika", DefaultLimit: 12, RecommendedLimit: 8, Homepage: "https://github.com/suzgunmirac/BIG-Bench-Hard"},
	{ID: "math-mini", Name: "MATH mini", Source: "BenchForge curated / MATH style", Description: "Zadania matematyczne na poziomie konkursowym z odpowiedzią końcową.", Category: "Logika", DefaultLimit: 12, RecommendedLimit: 8, Homepage: "https://github.com/hendrycks/math"},
	{ID: "gpqa-mini", Name: "GPQA mini", Source: "BenchForge curated / GPQA style", Description: "Trudne pytania naukowe graduate-level w wersji mini.", Category: "Wiedza", DefaultLimit: 8, RecommendedLimit: 6, Homepage: "https://github.com/idavidrein/gpqa"},
	{ID: "ifeval-mini", Name: "IFEval mini", Source: "BenchForge curated / IFEval style", Description: "Instruction Following Evaluation — sprawdza ścisłe trzymanie się wymagań formalnych.", Category: "Logika", DefaultLimit: 12, RecommendedLimit: 8, Homepage: "https://github.com/google-research/google-research/tree/master/instruction_following_eval"},
	{ID: "mt-bench-mini", Name: "MT-Bench mini", Source: "BenchForge curated / MT-Bench style", Description: "Wieloturowe polecenia do oceny jakości asystenta.", Category: "Kreatywność", DefaultLimit: 10, RecommendedLimit: 6, Homepage: "https://github.com/lm-sys/FastChat/tree/main/fastchat/llm_judge"},
	{ID: "alpacaeval-mini", Name: "AlpacaEval mini", Source: "BenchForge curated / AlpacaEval style", Description: "Ogólne instrukcje asystenckie do oceny jakości i użyteczności odpowiedzi.", Category: "Kreatywność", DefaultLimit: 10, RecommendedLimit: 6, Homepage: "https://github.com/tatsu-lab/alpaca_eval"},
	{ID: "humaneval-js-mini", Name: "HumanEval-JS mini", Source: "BenchForge curated / MultiPL-E style", Description: "Zadania programistyczne w JavaScript inspirowane HumanEval/MultiPL-E.", Category: "Kod", DefaultLimit: 10, RecommendedLimit: 6, Homepage: "https://github.com/nuprl/MultiPL-E"},
	{ID: "multipl-e-mini", Name: "MultiPL-E mini", Source: "BenchForge curated / MultiPL-E style", Description: "Wielojęzyczne zadania kodowe: Python, JS, TypeScript, Go, Rust.", Category: "Kod", DefaultLimit: 12, RecommendedLimit: 8, Homepage: "https://github.com/nuprl/MultiPL-E"},
	{ID: "bigcodebench-mini", Name: "BigCodeBench mini", Source: "BenchForge curated / BigCodeBench style", Description: "Bardziej realistyczne zadania kodowe z bibliotekami standardowymi.", Category: "Kod", DefaultLimit: 10, RecommendedLimit: 6, Homepage: "https://bigcode-bench.github.io/"},
	{ID: "apps-mini", Name: "APPS mini", Source: "BenchForge curated / APPS style", Description: "Zadania programistyczne algorytmiczne z opisem wejścia/wyjścia.", Category: "Kod", DefaultLimit: 10, RecommendedLimit: 6, Homepage: "https://github.com/hendrycks/apps"},
	{ID: "codecontests-mini", Name: "CodeContests mini", Source: "BenchForge curated / CodeContests style", Description: "Competitive programming — zadania algorytmiczne z przykładami.", Category: "Kod", DefaultLimit: 10, RecommendedLimit: 6, Homepage: "https://github.com/deepmind/code_contests"},
	{ID: "sql-eval-mini", Name: "SQL Eval mini", Source: "BenchForge curated / Spider style", Description: "Text-to-SQL w wersji mini — model generuje zapytania SQL.", Category: "Kod", DefaultLimit: 10, RecommendedLimit: 6, Homepage: "https://yale-lily.github.io/spider"},
	{ID: "rag-mini", Name: "RAG QA mini", Source: "BenchForge curated", Description: "Pytania z kontekstem — test czy model odpowiada tylko na podstawie dostarczonych dokumentów.", Category: "Wiedza", DefaultLimit: 10, RecommendedLimit: 6},
	{ID: "translation-mini", Name: "Translation mini", Source: "BenchForge curated / WMT style", Description: "Krótkie zadania tłumaczeniowe PL/EN/DE/ES.", Category: "Wiedza", DefaultLimit: 12, RecommendedLimit: 8, Homepage: "https://www.statmt.org/wmt"},
	{ID: "summarization-mini", Name: "Summarization mini", Source: "BenchForge curated / CNN-DM style", Description: "Streszczanie tekstu z ograniczeniami długości i zachowaniem faktów.", Category: "Kreatywność", DefaultLimit: 10, RecommendedLimit: 6},
	{ID: "safety-helpfulness-mini", Name: "Safety/Helpfulness mini", Source: "BenchForge curated", Description: "Bezpieczne i pomocne odpowiedzi w sytuacjach odmowy lub porad ogólnych.", Category: "Wiedza", DefaultLimit: 10, RecommendedLimit: 6},
	{ID: "visual-reasoning-mini", Name: "Visual reasoning mini", Source: "BenchForge curated / VQA style", Description: "Tekstowe zadania wizualnego rozumowania z opisem sceny.", Category: "Wizja", DefaultLimit: 10, RecommendedLimit: 6},
	{ID: "voxelbench-mini", Name: "VoxelBench mini", Source: "BenchForge curated / voxel-spatial style", Description: "Zadania przestrzenne 3D/voxel: model ma rozumować o siatkach 3D, objętości, sąsiedztwie i ścieżkach.", Category: "Wizja", DefaultLimit: 12, RecommendedLimit: 8},
	{ID: "maze-tools-mini", Name: "Maze Tool Solving mini", Source: "BenchForge curated / tool benchmark", Description: "Benchmark agentowy: model ma użyć narzędzi python.run / image.draw_path_svg do rozwiązania labiryntu i zapisania ścieżki.", Category: "Wizja", DefaultLimit: 4, RecommendedLimit: 4},
	{ID: "mcp-filesystem-mini", Name: "MCP Filesystem mini", Source: "BenchForge curated / MCP benchmark", Description: "Benchmark agentowy wymagający użycia MCP filesystem tools do czytania/listowania plików.", Category: "Kod", DefaultLimit: 6, RecommendedLimit: 4},
	{ID: "mcp-sqlite-mini", Name: "MCP SQLite mini", Source: "BenchForge curated / MCP benchmark", Description: "Benchmark agentowy pod MCP database/sqlite tools — pytania wymagają zapytań do bazy przez MCP.", Category: "Kod", DefaultLimit: 6, RecommendedLimit: 4},
	{ID: "mcp-browser-search-mini", Name: "MCP Browser/Search mini", Source: "BenchForge curated / MCP benchmark", Description: "Benchmark agentowy pod MCP browser/search tools — model ma używać wyszukiwarki/przeglądarki MCP i cytować źródło.", Category: "Wiedza", DefaultLimit: 6, RecommendedLimit: 4},
	{ID: "mcp-git-mini", Name: "MCP Git mini", Source: "BenchForge curated / MCP benchmark", Description: "Benchmark agentowy pod MCP git tools — model analizuje status, diff lub historię repozytorium przez MCP.", Category: "Kod", DefaultLimit: 6, RecommendedLimit: 4},
}

var totalTasks = map[string]int{
	"humaneval":             164,
	"mbpp":                  974,
	"gsm8k":                 1319,
	"swebench-lite":         300,
	"swebench-full":         2294,
	"swebench-verified":     500,
	"swebench-multilingual": 300,
	"swebench-multimodal":   510,
	"swebench-pro":          4,
}

func findCatalog(id string) (catalogItem, bool) {
	for _, item := range catalog {
		if item.ID == id {
			return item, true
		}
	}
	return catalogItem{}, false
}

// packMeta mirrors packMeta(id) from the JS module.
func packMeta(id string) catalogItem {
	if item, ok := findCatalog(id); ok {
		return item
	}
	return catalogItem{ID: id, Name: id, Category: "Inne", Description: ""}
}

func getKnownPackTaskCount(id string) int {
	switch id {
	case "swebench-pro":
		return 4
	case "mmlu-mini":
		return 6
	case "voxelbench-mini", "maze-tools-mini", "mcp-filesystem-mini", "mcp-sqlite-mini", "mcp-browser-search-mini", "mcp-git-mini":
		return 4
	}
	if p, ok := choicePacks[id]; ok {
		return len(p)
	}
	if p, ok := exactPacks[id]; ok {
		return len(p)
	}
	if p, ok := codePacks[id]; ok {
		return len(p)
	}
	if p, ok := manualPacks[id]; ok {
		return len(p)
	}
	return 0
}

type enriched struct {
	item             catalogItem
	defaultLimit     int
	recommendedLimit int
	totalTasks       int
}

func enrich(item catalogItem) enriched {
	known := getKnownPackTaskCount(item.ID)
	total := firstNonZero(totalTasks[item.ID], known, item.DefaultLimit, item.RecommendedLimit)
	def := minInt(firstNonZero(item.DefaultLimit, total), total)
	rec := minInt(firstNonZero(item.RecommendedLimit, def), total)
	return enriched{item: item, defaultLimit: def, recommendedLimit: rec, totalTasks: total}
}

func (e enriched) toMap() map[string]any {
	m := map[string]any{
		"id":               e.item.ID,
		"name":             e.item.Name,
		"source":           e.item.Source,
		"description":      e.item.Description,
		"category":         e.item.Category,
		"defaultLimit":     e.defaultLimit,
		"recommendedLimit": e.recommendedLimit,
		"totalTasks":       e.totalTasks,
	}
	if e.item.Homepage != "" {
		m["homepage"] = e.item.Homepage
	}
	return m
}

// ListPacks returns the benchmark catalog (listBenchmarkPacks in JS).
func ListPacks() []map[string]any {
	out := make([]map[string]any, 0, len(catalog))
	for _, item := range catalog {
		out = append(out, enrich(item).toMap())
	}
	return out
}

func firstNonZero(vals ...int) int {
	for _, v := range vals {
		if v != 0 {
			return v
		}
	}
	return 0
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
