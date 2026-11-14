package db

import "encoding/json"

func jsonUnmarshal(s string, out any) error { return json.Unmarshal([]byte(s), out) }
