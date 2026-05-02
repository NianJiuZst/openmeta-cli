import { describe, expect, test } from "bun:test";
import { getOpenMetaWordmarkLines } from "../src/infra/ui/brand.js";

describe("ui brand wordmark", () => {
	test("renders the canonical OpenMeta ascii wordmark", () => {
		const expected = String.raw`
    ___  ____  _____ _   _ __  __ _____ _____  _    
  / _ \|  _ \| ____| \ | |  \/  | ____|_   _|/ \   
 | | | | |_) |  _| |  \| | |\/| |  _|   | | / _ \  
 | |_| |  __/| |___| |\  | |  | | |___  | |/ ___ \ 
  \___/|_|   |_____|_| \_|_|  |_|_____| |_/_/   \_\
`
			.slice(1)
			.trimEnd()
			.split("\n");

		expect(getOpenMetaWordmarkLines()).toEqual(expected);
	});
});
