//go:build !windows

package main

import "errors"

func setTitle(string) {}

func isAdmin() bool { return true }

func runElevated(string, []string) (int, error) {
	return -1, errors.New("elevation is only needed on windows")
}

func refreshIcons() {}
