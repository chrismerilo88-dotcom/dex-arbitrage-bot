// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice Errors shared across the executor and more than one adapter.
/// Declared once here and imported everywhere, rather than redeclared
/// per-file -- redeclaring identically-named errors in separate files is
/// harmless on its own, but breaks the moment any single file (like a
/// deploy script) imports more than one of those files at once, since
/// Solidity then finds multiple conflicting definitions of the same name.
error ZeroAddress();
error UnsupportedRoute();
