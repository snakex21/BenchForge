package main

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

type providerFunc func(context.Context, string, string, Settings) (Output, error)

func (f providerFunc) Generate(c context.Context, m, p string, s Settings) (Output, error) {
	return f(c, m, p, s)
}
func fixture() Request {
	return Request{Suite: Suite{Version: Contract, ID: "test", Tasks: []Task{{"a", "4", "exact", "4"}, {"b", "14", "exact", "4"}, {"c", "Warsaw is a capital", "contains", "Warsaw"}}}, Models: []string{"echo"}, Settings: Settings{TimeoutMS: 100, MaxTokens: 256}}
}
func discard(Report) error { return nil }
func TestExactDoesNotAcceptSubstringOrSelfGrading(t *testing.T) {
	req := fixture()
	req.Suite.Tasks = append(req.Suite.Tasks, Task{"claim", "tak", "exact", "Warsaw"}, Task{"blank", " ", "exact", "4"})
	// The engine is also defensive against blank responses; use a nonblank request.
	req.Suite.Tasks[4].Prompt = "blank"
	p := providerFunc(func(ctx context.Context, m, p string, s Settings) (Output, error) {
		if p == "blank" {
			return Output{Text: "  "}, nil
		}
		return Output{Text: p}, nil
	})
	r := execute(context.Background(), newReport("x", req, "test"), p, discard)
	if r.State != "completed" || r.Summaries[0].Passed != 2 || r.Summaries[0].Failed != 3 || *r.Summaries[0].Score != 40 {
		t.Fatalf("bad result: %+v", r)
	}
}
func TestUniformSettingsRotatingOrderAndStableHash(t *testing.T) {
	req := fixture()
	req.Models = []string{"one", "two"}
	initial := newReport("x", req, "test")
	other := newReport("y", req, "test")
	if initial.SuiteHash != other.SuiteHash {
		t.Fatal("unstable hash")
	}
	var models []string
	p := providerFunc(func(ctx context.Context, m, p string, s Settings) (Output, error) {
		models = append(models, m)
		if s != req.Settings {
			t.Fatal("unequal settings")
		}
		return Output{Text: p}, nil
	})
	r := execute(context.Background(), initial, p, discard)
	if !reflect.DeepEqual(models, []string{"one", "two", "two", "one", "one", "two"}) {
		t.Fatal(models)
	}
	if len(r.Results) != 6 || r.Summaries[0].Passed != 2 || r.Summaries[1].Passed != 2 {
		t.Fatal(r)
	}
}
func TestCancelPreservesPartialAndDoesNotScoreSkipped(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	n := 0
	p := providerFunc(func(ctx context.Context, m, p string, s Settings) (Output, error) {
		n++
		if n == 2 {
			cancel()
			<-ctx.Done()
			return Output{}, ctx.Err()
		}
		return Output{Text: p}, nil
	})
	r := execute(ctx, newReport("x", fixture(), "test"), p, discard)
	if r.State != "cancelled" || r.Results[0].State != "passed" || r.Results[1].State != "cancelled" || r.Results[2].State != "skipped" || r.Summaries[0].Score != nil || n != 2 {
		t.Fatal(r)
	}
}
func TestTimeoutAndProviderErrorsAreNotComparableScores(t *testing.T) {
	req := fixture()
	req.Settings.TimeoutMS = 10
	p := providerFunc(func(ctx context.Context, m, p string, s Settings) (Output, error) {
		if p == "4" {
			<-ctx.Done()
			return Output{}, ctx.Err()
		}
		return Output{}, errors.New("offline")
	})
	r := execute(context.Background(), newReport("x", req, "test"), p, discard)
	if r.State != "completed_with_errors" || r.Results[0].State != "timeout" || r.Summaries[0].Score != nil || r.Summaries[0].Errors != 3 {
		t.Fatal(r)
	}
}
func TestStorageFailureStopsProviderCalls(t *testing.T) {
	calls := 0
	p := providerFunc(func(context.Context, string, string, Settings) (Output, error) { calls++; return Output{}, nil })
	r := execute(context.Background(), newReport("x", fixture(), "test"), p, func(Report) error { return errors.New("disk full") })
	if r.State != "storage_error" || calls != 0 || !strings.Contains(r.Error, "disk full") {
		t.Fatal(r)
	}
}
func TestContractValidation(t *testing.T) {
	cases := []func(*Request){func(r *Request) { r.Suite.Version = "legacy" }, func(r *Request) { r.Models = append(r.Models, r.Models[0]) }, func(r *Request) { r.Suite.Tasks[1].ID = "a" }, func(r *Request) { r.Suite.Tasks[0].Mode = "sandbox" }, func(r *Request) { r.Suite.Tasks[0].Expected = " " }, func(r *Request) { r.Settings.TimeoutMS = 0 }}
	for i, f := range cases {
		r := fixture()
		f(&r)
		if validate(r) == nil {
			t.Fatalf("accepted invalid case %d", i)
		}
	}
	if err := validate(fixture()); err != nil {
		t.Fatal(err)
	}
}
func TestReportJSONHasNoNaNAndExplicitVersion(t *testing.T) {
	r := newReport("x", fixture(), "test")
	b, err := json.Marshal(r)
	if err != nil || !strings.Contains(string(b), Contract) {
		t.Fatal(err)
	}
	if r.Started.After(time.Now()) {
		t.Fatal("future timestamp")
	}
}
