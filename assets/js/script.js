/* script.js
 * modernizr checks mainly
 */
window.onload = function() {

	function svgToPNG(element) {
		element.src = 'assets/images/' + element.id + '.png';
		//element.width = '60';
		//element.height = '60';
	}

	if (Modernizr.svg) {
		console.log('svg');
	} else {
		var mail = document.getElementById('mail');
		var github = document.getElementById('github');
		var linkedin = document.getElementById('linkedin');
		var stackoverflow = document.getElementById('stackoverflow');

		svgToPNG(mail);
		svgToPNG(github);
		svgToPNG(linkedin);
		svgToPNG(stackoverflow);
	}
}
