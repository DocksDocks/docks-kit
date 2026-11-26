// Fixture for the talk build test: a literal dynamic import of an omp host
// module. The build must keep it external and keep its argument literal.
// The file is JavaScript, so the type check does not resolve the host module.
export const loadWidth = async () => await import("@oh-my-pi/pi-tui/text/width");
