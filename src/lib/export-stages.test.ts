import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

const source = ts.createSourceFile(
	'capture-export.ts',
	readFileSync( new URL( './capture-export.ts', import.meta.url ), 'utf8' ),
	ts.ScriptTarget.Latest,
	true
);
const functions = source.statements.filter( ts.isFunctionDeclaration );
const stages = [ 'prepareExport', 'planExport', 'linkExport', 'renderExport', 'finalizeExport' ];

it( 'keeps the export build as the five ordered context stages', () => {
	const build = functions.find( node => node.name?.text === 'buildExportCapture' )!;
	const statements = build.body!.statements;
	expect( statements ).toHaveLength( 6 );
	expect( ts.isVariableStatement( statements[ 0 ] ) ).toBe( true );
	for ( const [ index, name ] of stages.entries() ) {
		const statement = statements[ index + 1 ];
		const expression = ts.isReturnStatement( statement ) ? statement.expression
			: ts.isExpressionStatement( statement ) ? statement.expression : undefined;
		expect( expression && ts.isCallExpression( expression ) && expression.expression.getText( source ) ).toBe( name );
		if ( expression && ts.isCallExpression( expression ) ) {
			expect( expression.arguments.map( argument => argument.getText( source ) ) ).toEqual( [ 'context' ] );
		}
	}
	expect( source.getLineAndCharacterOfPosition( build.end ).line - source.getLineAndCharacterOfPosition( build.getStart( source ) ).line ).toBeLessThanOrEqual( 60 );
	for ( const name of stages ) {
		const stage = functions.find( node => node.name?.text === name )!;
		expect( source.getLineAndCharacterOfPosition( stage.end ).line - source.getLineAndCharacterOfPosition( stage.getStart( source ) ).line ).toBeLessThanOrEqual( 350 );
	}
} );
